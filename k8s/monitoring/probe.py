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
import random
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
JIRA_EPIC_KEY = os.environ.get("JIRA_EPIC_KEY", "")
# MARSOHS is a company-managed project, so an epic is set through the legacy
# Epic Link custom field rather than through `parent`.
JIRA_EPIC_FIELD = os.environ.get("JIRA_EPIC_FIELD", "customfield_10014")
JIRA_LABEL = os.environ.get("JIRA_LABEL", "ops-oncall")
RENOTIFY_MINUTES = int(os.environ.get("JIRA_RENOTIFY_MINUTES", "30"))
DRY_RUN = os.environ.get("DRY_RUN", "false").lower() == "true"

# Shows starting sooner than this are skipped. The product legitimately closes
# online sales shortly before a showtime, and the probe must not alert on that.
MIN_LEAD_TIME = timedelta(hours=6)

# How many different seats to try before treating contention as a real fault.
SEAT_ATTEMPTS = int(os.environ.get("PROBE_SEAT_ATTEMPTS", "3"))


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


def error_code(payload: dict, status: int) -> str:
    """Pull the API's stable error code out of a failure response.

    The fingerprint is built from this, so it has to stay identical across
    runs of the same fault. The API nests the code as ``{"error": {"code":
    ...}}`` and puts variable data in the sibling message ("Seats do not
    exist in this auditorium: ZZ99"), so anything that drags the message in
    would produce a fresh fingerprint - and a fresh ticket - every run.
    """
    err = payload.get("error")
    if isinstance(err, dict):
        return str(err.get("code") or status)
    return str(payload.get("code") or err or status)


def expect(step: str, method: str, path: str, want: int, body: dict | None = None):
    status, payload = api(method, path, body)
    if status != want:
        if status == 0:
            code = "TRANSPORT"
            detail = payload.get("transport_error", "unreachable")
        else:
            code = error_code(payload, status)
            detail = json.dumps(payload)[:600]
        raise ProbeFailure(
            step,
            f"{method} {path} returned {status or 'no response'}, expected {want}",
            detail,
            code,
        )
    return payload


def journey(trace: list[str]) -> None:
    """Run the full booking journey, appending progress to ``trace``.

    The caller owns the list so that the steps completed before a failure
    survive the exception and can be put in the ticket.
    """
    state: dict[str, str | None] = {"hold": None, "booking": None}
    try:
        _journey(trace, state)
    finally:
        release(state, trace)


def release(state: dict, trace: list[str]) -> None:
    """Give back whatever the run was holding, however it ended.

    Without this a run that fails after the hold leaves the seat locked for
    the length of the hold TTL, so the next run finds it taken and reports a
    different step and a different fingerprint. One fault would then open a
    second ticket, and the probe would eat a seat a minute.
    """
    if state.get("booking"):
        status, _ = api("DELETE", f"/api/bookings/{state['booking']}")
        trace.append(f"cleanup: cancelled {state['booking']} ({status})")
    elif state.get("hold"):
        status, _ = api("DELETE", f"/api/holds/{state['hold']}")
        trace.append(f"cleanup: released hold ({status})")


def _journey(trace: list[str], state: dict) -> list[str]:

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

    # Losing a race for one seat is not an outage: the seat map is a snapshot,
    # and anything can take the seat between reading it and holding it. Only
    # give up once several distinct seats have been refused.
    seat = None
    hold = None
    for attempt in range(1, SEAT_ATTEMPTS + 1):
        seatmap = expect("seatmap", "GET", f"/api/shows/{show['id']}/seats", 200)
        available = [s for s in seatmap.get("seats", []) if s.get("status") == "available"]
        if not available:
            raise ProbeFailure(
                "seatmap",
                f"Show {show['id']} has no available seats",
                f"seats: {len(seatmap.get('seats', []))}, available: 0",
                "NO_SEATS",
            )
        seat = random.choice(available)["id"]
        trace.append(f"seatmap: {len(available)} available, trying {seat}")

        status, payload = api("POST", "/api/holds", {"showId": show["id"], "seatIds": [seat]})
        if status == 201:
            hold = payload["hold"]
            break
        if status == 409 and error_code(payload, status) == "SEATS_UNAVAILABLE":
            trace.append(f"hold: {seat} taken, retrying ({attempt}/{SEAT_ATTEMPTS})")
            continue
        raise ProbeFailure(
            "hold",
            f"POST /api/holds returned {status or 'no response'}, expected 201",
            json.dumps(payload)[:600] if status else payload.get("transport_error", "unreachable"),
            error_code(payload, status) if status else "TRANSPORT",
        )

    if hold is None:
        raise ProbeFailure(
            "hold",
            f"Could not hold any of {SEAT_ATTEMPTS} seats offered as available",
            f"last seat tried: {seat}",
            "SEATS_UNAVAILABLE",
        )
    state["hold"] = hold["id"]
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
    state["booking"] = reference
    trace.append(f"book: {reference}")

    expect("lookup", "GET", f"/api/bookings/{reference}", 200)
    trace.append("lookup: confirmation retrievable")

    # The seat must actually read as taken afterwards. A booking that confirms
    # but leaves the seat available is the signature of a lost write.
    after = expect("verify", "GET", f"/api/shows/{show['id']}/seats", 200)
    seat_state = next((s for s in after.get("seats", []) if s["id"] == seat), None)
    if seat_state is None or seat_state.get("status") == "available":
        raise ProbeFailure(
            "verify",
            f"Seat {seat} still reads as available after booking {reference}",
            f"seat state after booking: {json.dumps(seat_state)}",
            "LOST_WRITE",
        )
    trace.append(f"verify: {seat} now {seat_state.get('status')}")

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


# Returned when the duplicate check could not be carried out at all. Kept
# distinct from "no open ticket": if we cannot tell, filing anyway would open
# a fresh ticket on every run for as long as Jira search stays unhappy.
SEARCH_FAILED = object()


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
    if status >= 300 or status == 0:
        print(f"jira: search failed ({status}): {json.dumps(payload)[:300]}", file=sys.stderr)
        return SEARCH_FAILED
    issues = payload.get("issues") or []
    return issues[0] if issues else None


def jira_create(failure: ProbeFailure, trace: list[str]) -> str | None:
    fields = {
        "project": {"key": JIRA_PROJECT},
        "issuetype": {"name": JIRA_ISSUE_TYPE},
        "summary": f"[{ENVIRONMENT}] Booking journey failing at '{failure.step}': {failure.summary}",
        # fp-* is what makes deduplication work: it is how a later run
        # recognises that this exact failure already has an open ticket.
        "labels": [JIRA_LABEL, f"env-{ENVIRONMENT}", f"fp-{failure.fingerprint}"],
    }
    fields["description"] = adf([
        "The synthetic customer-journey probe could not complete a booking.",
        f"Environment: {ENVIRONMENT}",
        f"Failing step: {failure.step}",
        f"Observed: {failure.summary}",
        f"Response: {failure.detail}",
        "Steps completed before the failure:",
        "\n".join(trace) if trace else "(none - failed on the first call)",
        f"Probe target: {BASE}",
        f"Detected at: {datetime.now(timezone.utc).isoformat()}",
    ])
    if JIRA_EPIC_KEY:
        fields[JIRA_EPIC_FIELD] = JIRA_EPIC_KEY

    status, payload = request(
        "POST", f"{JIRA_BASE}/rest/api/3/issue", {"fields": fields}, auth=jira_auth()
    )
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


def parse_timestamp(raw: str) -> datetime | None:
    """Parse a Jira timestamp.

    Jira returns a numeric offset without a colon (``-0400``), which
    fromisoformat only accepts from Python 3.11 onwards.
    """
    text = raw.strip().replace("Z", "+00:00")
    if len(text) > 5 and text[-5] in "+-" and text[-3] != ":":
        text = f"{text[:-2]}:{text[-2:]}"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def stale(issue: dict) -> bool:
    """True if the issue has not been touched for RENOTIFY_MINUTES.

    Errs towards staying quiet. The ticket is already open either way, and a
    probe that runs every minute would otherwise bury it in comments.
    """
    raw = (issue.get("fields") or {}).get("updated")
    updated = parse_timestamp(raw) if raw else None
    if updated is None:
        print(f"jira: could not read 'updated' ({raw!r}), not re-notifying", file=sys.stderr)
        return False
    return datetime.now(timezone.utc) - updated > timedelta(minutes=RENOTIFY_MINUTES)


def report(failure: ProbeFailure, trace: list[str]) -> None:
    if DRY_RUN or not (JIRA_BASE and JIRA_PROJECT and JIRA_TOKEN):
        print(f"jira: DRY_RUN, would file fp-{failure.fingerprint}: {failure.summary}")
        return
    existing = jira_find_open(failure.fingerprint)
    if existing is SEARCH_FAILED:
        print("jira: cannot confirm whether this is already filed, leaving it alone")
        return
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
        journey(trace)
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
