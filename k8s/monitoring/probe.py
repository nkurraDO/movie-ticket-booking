#!/usr/bin/env python3
"""Synthetic customer-journey probe.

Walks the booking path a real customer takes, through the frontend's nginx
proxy rather than straight to the API, so that a break anywhere in the chain
(ingress, proxy config, Service resolution, backend) shows up the same way it
would for a customer.

On failure the probe opens a Jira issue. Repeat failures of the same kind fold
into the existing issue instead of filing a new one.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = os.environ.get("PROBE_TARGET", "http://mtb-frontend.movie-booking.svc.cluster.local")
ENVIRONMENT = os.environ.get("ENVIRONMENT", "production")
TIMEOUT = float(os.environ.get("PROBE_TIMEOUT_SECONDS", "10"))

JIRA_BASE = os.environ.get("JIRA_BASE_URL", "").rstrip("/")
JIRA_PROJECT = os.environ.get("JIRA_PROJECT_KEY", "")
JIRA_EMAIL = os.environ.get("JIRA_EMAIL", "")
JIRA_TOKEN = os.environ.get("JIRA_API_TOKEN", "")
JIRA_ISSUE_TYPE = os.environ.get("JIRA_ISSUE_TYPE", "Bug")
RENOTIFY_MINUTES = int(os.environ.get("JIRA_RENOTIFY_MINUTES", "30"))
DRY_RUN = os.environ.get("DRY_RUN", "false").lower() == "true"

# Shows starting sooner than this are skipped. The product legitimately closes
# online sales shortly before a showtime, and the probe must not alert on that.
MIN_LEAD_TIME = timedelta(hours=6)


class ProbeFailure(Exception):
    def __init__(self, step: str, summary: str, detail: str, code: str):
        super().__init__(summary)
        self.step = step
        self.summary = summary
        self.detail = detail
        self.code = code

    @property
    def fingerprint(self) -> str:
        raw = f"{ENVIRONMENT}|{self.step}|{self.code}"
        return hashlib.sha1(raw.encode()).hexdigest()[:10]


def request(method: str, url: str, body: dict | None = None, auth: str | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")
    if auth:
        req.add_header("Authorization", f"Basic {auth}")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode(errors="replace")
        try:
            parsed = json.loads(raw)
        except ValueError:
            parsed = {"raw": raw[:500]}
        return exc.code, parsed
    except Exception as exc:  # timeout, DNS, connection refused
        return 0, {"transport_error": f"{type(exc).__name__}: {exc}"}


def api(method: str, path: str, body: dict | None = None):
    return request(method, f"{BASE}{path}", body)


def expect(step: str, method: str, path: str, want: int, body: dict | None = None):
    status, payload = api(method, path, body)
    if status != want:
        if status == 0:
            code = "TRANSPORT"
            detail = payload.get("transport_error", "unreachable")
        else:
            code = str(payload.get("code") or payload.get("error") or status)
            detail = json.dumps(payload)[:600]
        raise ProbeFailure(
            step,
            f"{method} {path} returned {status or 'no response'}, expected {want}",
            detail,
            code,
        )
    return payload


def journey() -> list[str]:
    """Run the full booking journey. Returns a human-readable trace."""
    trace: list[str] = []

    movies = expect("catalogue", "GET", "/api/movies", 200).get("movies", [])
    if not movies:
        raise ProbeFailure("catalogue", "Movie catalogue is empty", "movies: []", "EMPTY_CATALOGUE")
    trace.append(f"catalogue: {len(movies)} movies")

    shows = expect("schedule", "GET", "/api/shows", 200).get("shows", [])
    cutoff = datetime.now(timezone.utc) + MIN_LEAD_TIME
    bookable = [
        s for s in shows
        if datetime.fromisoformat(s["startsAt"].replace("Z", "+00:00")) > cutoff
    ]
    if not bookable:
        raise ProbeFailure(
            "schedule",
            "No show is far enough out to be bookable",
            f"{len(shows)} shows returned, none starting after {cutoff.isoformat()}",
            "NO_BOOKABLE_SHOW",
        )
    show = bookable[0]
    trace.append(f"schedule: {len(shows)} shows, probing {show['id']}")

    seatmap = expect("seatmap", "GET", f"/api/shows/{show['id']}/seats", 200)
    available = [s for s in seatmap.get("seats", []) if s.get("status") == "available"]
    if not available:
        raise ProbeFailure(
            "seatmap",
            f"Show {show['id']} has no available seats",
            f"seats: {len(seatmap.get('seats', []))}, available: 0",
            "NO_SEATS",
        )
    seat = available[len(available) // 2]["id"]
    trace.append(f"seatmap: {len(available)} seats available, selecting {seat}")

    hold = expect(
        "hold", "POST", "/api/holds", 201,
        {"showId": show["id"], "seatIds": [seat]},
    )["hold"]
    trace.append(f"hold: {hold['id']}")

    booking = expect(
        "book", "POST", "/api/bookings", 201,
        {
            "showId": show["id"],
            "seatIds": [seat],
            "holdId": hold["id"],
            "customerName": "Synthetic Probe",
            "email": "probe@movie-booking.invalid",
        },
    )["booking"]
    reference = booking["reference"]
    trace.append(f"book: {reference}")

    expect("lookup", "GET", f"/api/bookings/{reference}", 200)
    trace.append("lookup: confirmation retrievable")

    # The seat must actually read as taken afterwards. A booking that confirms
    # but leaves the seat available is the signature of a lost write.
    after = expect("verify", "GET", f"/api/shows/{show['id']}/seats", 200)
    state = next((s for s in after.get("seats", []) if s["id"] == seat), None)
    if state is None or state.get("status") == "available":
        raise ProbeFailure(
            "verify",
            f"Seat {seat} still reads as available after booking {reference}",
            f"seat state after booking: {json.dumps(state)}",
            "LOST_WRITE",
        )
    trace.append(f"verify: {seat} now {state.get('status')}")

    # Best effort: give the seat back so the probe does not consume inventory.
    status, _ = api("DELETE", f"/api/bookings/{reference}")
    trace.append(f"cleanup: cancel returned {status}")

    return trace


# ------------------------------------------------------------------ Jira


def jira_auth() -> str:
    return base64.b64encode(f"{JIRA_EMAIL}:{JIRA_TOKEN}".encode()).decode()


def adf(paragraphs: list[str]) -> dict:
    return {
        "type": "doc",
        "version": 1,
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": p}]}
            for p in paragraphs
        ],
    }


def jira_find_open(fingerprint: str):
    jql = (
        f'project = "{JIRA_PROJECT}" AND labels = "fp-{fingerprint}" '
        f"AND statusCategory != Done ORDER BY created DESC"
    )
    status, payload = request(
        "POST", f"{JIRA_BASE}/rest/api/3/search/jql",
        {"jql": jql, "fields": ["updated", "status"], "maxResults": 5},
        auth=jira_auth(),
    )
    if status == 404:  # older Jira Cloud sites
        status, payload = request(
            "GET",
            f"{JIRA_BASE}/rest/api/3/search?"
            + urllib.parse.urlencode({"jql": jql, "fields": "updated,status", "maxResults": 5}),
            auth=jira_auth(),
        )
    if status >= 300:
        print(f"jira: search failed ({status}): {json.dumps(payload)[:300]}", file=sys.stderr)
        return None
    issues = payload.get("issues") or []
    return issues[0] if issues else None


def jira_create(failure: ProbeFailure, trace: list[str]) -> str | None:
    body = {
        "fields": {
            "project": {"key": JIRA_PROJECT},
            "issuetype": {"name": JIRA_ISSUE_TYPE},
            "summary": f"[{ENVIRONMENT}] Booking journey failing at '{failure.step}': {failure.summary}",
            "labels": ["mtb-synthetic", f"env-{ENVIRONMENT}", f"fp-{failure.fingerprint}"],
            "description": adf([
                "The synthetic customer-journey probe could not complete a booking.",
                f"Environment: {ENVIRONMENT}",
                f"Failing step: {failure.step}",
                f"Observed: {failure.summary}",
                f"Response: {failure.detail}",
                "Steps completed before the failure:",
                "\n".join(trace) if trace else "(none - failed on the first call)",
                f"Probe target: {BASE}",
                f"Detected at: {datetime.now(timezone.utc).isoformat()}",
            ]),
        }
    }
    status, payload = request("POST", f"{JIRA_BASE}/rest/api/3/issue", body, auth=jira_auth())
    if status >= 300:
        print(f"jira: create failed ({status}): {json.dumps(payload)[:400]}", file=sys.stderr)
        return None
    return payload.get("key")


def jira_comment(key: str, text: str) -> None:
    status, payload = request(
        "POST", f"{JIRA_BASE}/rest/api/3/issue/{key}/comment",
        {"body": adf([text])}, auth=jira_auth(),
    )
    if status >= 300:
        print(f"jira: comment failed ({status}): {json.dumps(payload)[:300]}", file=sys.stderr)


def stale(issue: dict) -> bool:
    """True if the issue has not been touched for RENOTIFY_MINUTES."""
    raw = (issue.get("fields") or {}).get("updated")
    if not raw:
        return True
    try:
        updated = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return True
    return datetime.now(timezone.utc) - updated > timedelta(minutes=RENOTIFY_MINUTES)


def report(failure: ProbeFailure, trace: list[str]) -> None:
    if DRY_RUN or not (JIRA_BASE and JIRA_PROJECT and JIRA_TOKEN):
        print(f"jira: DRY_RUN, would file fp-{failure.fingerprint}: {failure.summary}")
        return
    existing = jira_find_open(failure.fingerprint)
    if existing:
        key = existing["key"]
        if stale(existing):
            jira_comment(key, f"Still failing at {datetime.now(timezone.utc).isoformat()}: {failure.summary}")
            print(f"jira: {key} still open, added a recurrence note")
        else:
            print(f"jira: {key} already open and recently updated, staying quiet")
        return
    key = jira_create(failure, trace)
    print(f"jira: opened {key}" if key else "jira: could not open an issue")


def main() -> int:
    trace: list[str] = []
    try:
        trace = journey()
    except ProbeFailure as failure:
        print(f"FAIL [{failure.step}] {failure.summary}")
        print(f"  fingerprint: fp-{failure.fingerprint}")
        print(f"  detail: {failure.detail}")
        for line in trace:
            print(f"  completed: {line}")
        report(failure, trace)
        return 1
    print(f"OK {ENVIRONMENT}: booking journey completed")
    for line in trace:
        print(f"  {line}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
