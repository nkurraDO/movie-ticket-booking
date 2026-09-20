#!/usr/bin/env python3
"""Watch what real customers are actually getting back.

The synthetic probe answers "can a booking be completed right now". This
answers the different question of "is anyone out there hitting a wall", by
reading the ingress access log, which records every request that reached the
cluster from outside along with the status it was served.

The ingress controller exports no per-request metrics in this build -
nginx_ingress_controller_requests has no series - so the access log is the
only place the status of real traffic exists.

Deliberately blind to the probe: the probe talks to the frontend Service
directly and never passes through the ingress, so nothing here is self-
inflicted. Every line represents somebody outside the cluster.
"""

from __future__ import annotations

import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from datetime import datetime, timezone

# Reuses the probe's Jira handling so both alert sources dedupe identically
# and a fault cannot open one ticket per source.
from probe import ENVIRONMENT, ProbeFailure, report

NAMESPACE = os.environ.get("INGRESS_NAMESPACE", "ingress-nginx")
POD_SELECTOR = os.environ.get("INGRESS_SELECTOR", "app.kubernetes.io/component=controller")
POLL_SECONDS = int(os.environ.get("TRAFFIC_POLL_SECONDS", "10"))
WATCH_PREFIX = os.environ.get("TRAFFIC_PATH_PREFIX", "/api")
MIN_STATUS = int(os.environ.get("TRAFFIC_MIN_STATUS", "500"))

SA = "/var/run/secrets/kubernetes.io/serviceaccount"
API = f"https://{os.environ.get('KUBERNETES_SERVICE_HOST')}:{os.environ.get('KUBERNETES_SERVICE_PORT', '443')}"

# nginx's combined-plus format. The request id is the final field and is
# unique per request, which is what keeps overlapping polls from counting the
# same failure twice.
LINE = re.compile(
    r'^(?P<ip>\S+) \S+ \S+ \[(?P<when>[^\]]+)\] '
    r'"(?P<method>\S+) (?P<path>\S+) [^"]*" (?P<status>\d{3}) '
)


def token() -> str:
    with open(f"{SA}/token") as fh:
        return fh.read().strip()


def k8s(path: str) -> str:
    req = urllib.request.Request(f"{API}{path}")
    req.add_header("Authorization", f"Bearer {token()}")
    ctx = ssl.create_default_context(cafile=f"{SA}/ca.crt")
    with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
        return resp.read().decode(errors="replace")


def controller_pods() -> list[str]:
    raw = k8s(f"/api/v1/namespaces/{NAMESPACE}/pods?labelSelector={urllib.parse.quote(POD_SELECTOR)}")
    return [p["metadata"]["name"] for p in json.loads(raw).get("items", [])]


def recent_lines(pod: str, seconds: int) -> list[str]:
    raw = k8s(f"/api/v1/namespaces/{NAMESPACE}/pods/{pod}/log?sinceSeconds={seconds}")
    return raw.splitlines()


def main() -> int:
    if not os.environ.get("KUBERNETES_SERVICE_HOST"):
        print("traffic: not running in a cluster, nothing to watch", file=sys.stderr)
        return 1

    print(
        f"traffic: watching {WATCH_PREFIX} for >={MIN_STATUS} "
        f"in {NAMESPACE} every {POLL_SECONDS}s",
        flush=True,
    )
    # Bounded so a long-lived watcher cannot grow without limit.
    seen: deque[str] = deque(maxlen=20000)
    seen_set: set[str] = set()
    first_pass = True

    while True:
        started = time.monotonic()
        try:
            failures: list[tuple[str, str, str]] = []
            total = 0
            for pod in controller_pods():
                for line in recent_lines(pod, POLL_SECONDS + 10):
                    match = LINE.match(line)
                    if not match:
                        continue
                    request_id = line.rsplit(" ", 1)[-1]
                    if request_id in seen_set:
                        continue
                    seen_set.add(request_id)
                    if len(seen) == seen.maxlen:
                        seen_set.discard(seen[0])
                    seen.append(request_id)

                    total += 1
                    path, status = match.group("path"), int(match.group("status"))
                    if path.startswith(WATCH_PREFIX) and status >= MIN_STATUS:
                        failures.append((match.group("ip"), path, str(status)))

            # The first pass backfills whatever is already in the log buffer.
            # Alerting on it would report an outage that may long be over.
            if first_pass:
                first_pass = False
                print(f"traffic: primed with {total} recent requests", flush=True)
                continue

            stamp = datetime.now(timezone.utc).strftime("%H:%M:%S")
            if failures:
                statuses = sorted({f[2] for f in failures})
                paths = sorted({f[1] for f in failures})
                clients = len({f[0] for f in failures})
                print(f"{stamp} {len(failures)} customer-facing {'/'.join(statuses)} on {paths}", flush=True)
                alert(failures, statuses, paths, clients)
            else:
                print(f"{stamp} ok: {total} requests, none failing", flush=True)
        except Exception as exc:
            print(f"traffic: poll failed: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)

        while time.monotonic() - started < POLL_SECONDS:
            time.sleep(0.5)


def alert(failures: list, statuses: list[str], paths: list[str], clients: int) -> None:
    status = statuses[0]
    sample = failures[:5]
    failure = ProbeFailure(
        step="traffic",
        summary=f"{len(failures)} request(s) from {clients} client(s) got {'/'.join(statuses)} on {', '.join(paths)}",
        detail="; ".join(f"{ip} {path} -> {code}" for ip, path, code in sample),
        code=f"HTTP_{status}",
        headline=f"Customers are getting {'/'.join(statuses)} on {WATCH_PREFIX}",
    )
    failure.detail_intro = (
        "Real customer traffic is failing at the ingress. These are requests "
        "from outside the cluster, not synthetic checks."
    )
    failure.trace_label = "Sample of the failing requests:"
    report(failure, [f"{ip} {path} -> {code}" for ip, path, code in sample])


if __name__ == "__main__":
    sys.exit(main())
