# CineBook — Movie Ticket Booking System

A movie ticket booking application built as **two independent services** that are
developed, containerized, deployed and scaled separately.

| Service | Stack | Container port | Image |
| --- | --- | --- | --- |
| `mtb-frontend` | React 18, TypeScript, Vite, nginx | 8080 | `mtb-frontend` |
| `mtb-backend` | Node 22, Express, TypeScript, Zod | 4000 | `mtb-backend` |

The browser only ever talks to the frontend origin. nginx forwards `/api` to the
backend Service over cluster DNS, so there is no CORS configuration to manage
and the backend is never exposed directly to the internet.

```
                ┌──────────────┐        /api        ┌─────────────┐
  Browser ─────▶│ mtb-frontend │ ─────────────────▶ │ mtb-backend │
                │   (nginx)    │   ClusterIP:4000   │  (Express)  │
                └──────────────┘                    └─────────────┘
                     Service                            Service
                  ClusterIP:80                       ClusterIP:4000
```

## Features

- Browse and search the film catalogue
- Showtimes grouped by day across multiple theaters and screens
- Interactive seat map with standard / premium / recliner pricing tiers
- Booking with server-side validation and conflict detection on taken seats
- Short-lived seat holds so seats are reserved during checkout
- Booking lookup by reference or email, plus cancellation
- `/api/stats` counters for dashboards

## Repository layout

```
backend/           Express API (TypeScript)
  src/routes/      HTTP layer
  src/lib/store.ts Booking domain logic and in-memory persistence
  src/data/seed.ts Films, theaters and generated showtimes
frontend/          React single-page app
  src/pages/       Films, showtimes, seat picker, confirmation, bookings
  nginx/           Runtime nginx template and resolver hook
k8s/base/          Namespace, both services, ingress
k8s/overlays/dev   Local cluster: single replicas, no HPA/PDB
k8s/overlays/prod  Registry images, 3 web replicas, real hostname
k8s/overlays/doks  DigitalOcean Kubernetes with images in DOCR
k8s/overlays/preprod  Pre-production DOKS cluster, kept in step with doks
k8s/optional/      Backend HPA (see the scaling note below)
```

## Run locally

Two terminals, hot reload on both sides:

```bash
make install
cd backend  && npm run dev      # http://localhost:4000
cd frontend && npm run dev      # http://localhost:5173
```

Vite proxies `/api` to `localhost:4000`, matching what nginx does in production.

## Run as containers

```bash
make compose-up                 # http://localhost:8080
make compose-down
```

## Deploy to Kubernetes

```bash
make deploy                     # builds images, applies k8s/overlays/dev
make status
make forward                    # http://localhost:8080
```

`make deploy` assumes the cluster can see locally built images, which is true
for OrbStack and Docker Desktop. On kind or minikube, load them first:

```bash
kind load docker-image mtb-backend:local mtb-frontend:local
minikube image load mtb-backend:local && minikube image load mtb-frontend:local
```

To reach it through an Ingress controller instead of port-forwarding, add
`127.0.0.1 movies.localhost` to `/etc/hosts` and browse to
`http://movies.localhost`.

For a generic registry-backed environment, push images and apply the prod
overlay:

```bash
make images push TAG=1.0.0 REGISTRY=ghcr.io/<you>
kubectl apply -k k8s/overlays/prod
```

Remove everything with `make undeploy`.

## Deploy to DigitalOcean Kubernetes

The `doks` overlay targets DOKS with images in DigitalOcean Container Registry.
It is currently deployed to the `do-atl1-movie-booking-prod` cluster.

```bash
export KUBECONFIG=~/Desktop/K8sconfigs/newteam-kubeconfig.yaml
make doks-images            # cross-build linux/amd64 and push to DOCR
make doks-deploy            # pull secret + apply the doks overlay
```

Four things differ from a local cluster, and each one bites if missed:

**Build for the cluster's architecture.** DOKS nodes are `amd64`. An image
built on an Apple Silicon Mac is `arm64` and crash-loops with an exec format
error, so the Makefile passes `--platform linux/amd64` to `docker buildx`.

**One repository, two tags.** The DOCR Starter tier permits a single
repository, so both services share `movie-ticket-booking` and are
distinguished by tag (`backend-1.0.0`, `frontend-1.0.0`) instead of by
repository name. On Basic or above, switch the overlay to separate
`mtb-backend` and `mtb-frontend` repositories.

**Pull credentials go on the pod spec.** DOKS can inject registry credentials
into a namespace's *default* ServiceAccount, but these pods run under their own
ServiceAccounts, so the overlay attaches `imagePullSecrets` directly. Create the
secret first — `doctl` names it `registry-<registry-name>`:

```bash
doctl registry kubernetes-manifest --namespace movie-booking | kubectl apply -f -
```

**Proxy protocol must be turned off.** DigitalOcean now provisions
`REGIONAL_NETWORK` (layer 4 passthrough) load balancers, which do not send
PROXY-protocol headers, but the upstream ingress-nginx manifest for DO still
configures nginx to expect them. The mismatch makes every request return an
empty reply. After installing the controller:

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.15.1/deploy/static/provider/do/deploy.yaml
kubectl -n ingress-nginx patch cm ingress-nginx-controller \
  --type merge -p '{"data":{"use-proxy-protocol":"false"}}'
kubectl -n ingress-nginx annotate svc ingress-nginx-controller \
  service.beta.kubernetes.io/do-loadbalancer-enable-proxy-protocol="false" --overwrite
```

The client IP is still preserved: the network load balancer passes it through
and the Service uses `externalTrafficPolicy: Local`.

The overlay strips the Ingress `host` so the app answers on the load balancer
IP directly. Once DNS points at that IP, put the hostname back and add
cert-manager for TLS.

Traffic inside the namespace is unrestricted: any pod can reach the backend
directly, not only the frontend and the ingress controller.

### Pre-production

The `preprod` overlay targets a second DOKS cluster (`do-atl1-movie-booking-preprod`) built
to the same shape as production: same region, same node size, same Kubernetes
minor version, same ingress-nginx release and the same PROXY-protocol and
source-range settings on its load balancer. It exists so that a change can be
observed running before it reaches production.

Merges to `main` deploy here automatically, ahead of production. To apply it
by hand:

```bash
kubectl --context do-atl1-movie-booking-preprod apply -k k8s/overlays/preprod
```

Keep the two overlays in step. The point of a pre-production environment is
that it is a fair test, and every setting that differs is a way for a change to
pass here and still fail in production. To see what currently differs:

```bash
diff <(kubectl kustomize k8s/overlays/preprod) <(kubectl kustomize k8s/overlays/doks)
```

### Promotion pipeline

`.github/workflows/deploy.yml` runs on every merge to `main` and promotes in
one ordered pass:

```
build and push images  ->  pre-production  ->  production
```

Images are built once and both environments are pinned to the same
commit-SHA tags, so production runs the bits pre-production was checked on.
Rebuilding per environment would defeat the purpose, since the artifact tested
would not be the artifact shipped. Production runs only if pre-production
rolled out cleanly.

Both stages share `.github/workflows/deploy-env.yml`, so the two environments
cannot drift apart in *how* they are rolled out — only in which cluster and
overlay they target. Each stage maps to a GitHub environment (`preprod`,
`production`), so approval gates can be attached per stage.

Note that the smoke test is read-only today: it fetches the catalogue and the
static app, so it will not catch a regression that only affects writes.

### Restricting the public endpoint to your IP

The deployment is currently locked to a single source IP so the internet at
large cannot reach it:

```bash
make doks-allow-ip                          # uses your current public IPv4
make doks-allow-ip ALLOW_CIDR=203.0.113.0/24  # or an explicit range
make doks-show-firewall                     # what is allowed today
make doks-open                              # go public again
```

This sets `spec.loadBalancerSourceRanges` on the `ingress-nginx-controller`
Service. DigitalOcean's cloud controller turns that into a firewall rule on
the load balancer itself, so unwanted traffic is dropped at DO's edge and
never reaches the cluster, the ingress controller, or the pods. Verify with:

```bash
doctl compute load-balancer get <lb-id> -o json | jq '.[0].firewall'
# {"allow": ["cidr:203.0.113.10/32"]}
```

Two caveats. The rule pins one IPv4 address, so a residential IP that rotates
will lock you out — rerun `make doks-allow-ip` to refresh it. And the rule is
applied to the load balancer Service, which comes from the upstream
ingress-nginx manifest rather than this repo, so reinstalling the controller
resets it to fully public.

An in-cluster alternative is the
`nginx.ingress.kubernetes.io/whitelist-source-range` annotation on the
Ingress. It works because the network load balancer preserves the client IP,
but it filters after traffic has already reached the cluster and answers
with 403 rather than dropping the connection, so it is the weaker control
of the two.

## API

Base path `/api`. Errors return `{"error":{"code","message","details"}}`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/movies?search=&genre=` | List films |
| `GET` | `/movies/:id` | Film plus its upcoming showtimes |
| `GET` | `/theaters` | List theaters |
| `GET` | `/shows?movieId=&date=` | List showtimes |
| `GET` | `/shows/:id/seats` | Seat map with live availability and pricing |
| `POST` | `/holds` | Reserve seats during checkout |
| `DELETE` | `/holds/:id` | Release a hold |
| `POST` | `/bookings` | Create a booking |
| `GET` | `/bookings?email=` | List bookings for an email |
| `GET` | `/bookings/:reference` | Booking with show, film and theater |
| `DELETE` | `/bookings/:reference` | Cancel a booking |
| `GET` | `/stats` | Aggregate counters |

`GET /healthz` (liveness) and `GET /readyz` (readiness) sit outside `/api`.

Book three seats:

```bash
curl -X POST http://localhost:8080/api/bookings \
  -H 'Content-Type: application/json' \
  -d '{"showId":"show-mov-interstellar-0-0","seatIds":["C4","C5","C6"],
       "customerName":"Grace Hopper","email":"grace@example.com"}'
```

Requesting a seat that is already taken returns `409 SEATS_UNAVAILABLE` and
names the conflicting seats.

## Configuration

Backend (`mtb-backend-config`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4000` | Listen port |
| `CORS_ORIGIN` | `*` | Comma-separated allowed origins |
| `SEAT_HOLD_TTL_MS` | `300000` | How long a checkout hold lasts |
| `MAX_SEATS_PER_BOOKING` | `10` | Per-booking seat cap |
| `SALES_CUTOFF_MINUTES` | `0` | Minutes before showtime that online sales close (`0` disables) |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Grace period before a forced exit |

Frontend (`mtb-frontend-config`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `BACKEND_URL` | `http://mtb-backend.movie-booking.svc.cluster.local:4000` | Proxy target for `/api` |

## Production readiness

Both Deployments run as non-root with a read-only root filesystem, all
capabilities dropped, `RuntimeDefault` seccomp and no service account token
mounted; the namespace enforces the `restricted` Pod Security Standard.
Each has startup, liveness and readiness probes, resource requests and limits,
and a rolling update with `maxUnavailable: 0`.

Shutdown is handled on both sides: the backend fails `/readyz` on `SIGTERM`
before closing the listener, and the frontend sleeps through endpoint removal
before `nginx -s quit`, so neither drops in-flight requests during a rollout.

nginx resolves the backend at request time using the cluster resolver it reads
from `/etc/resolv.conf` at startup, so a frontend pod starts cleanly even when
the backend has no ready endpoints yet.

There are no NetworkPolicies, so pod-to-pod traffic in the namespace is
unrestricted and the backend Service is reachable from anything in the
cluster. Restoring a default-deny policy needs a CNI that enforces it
(Calico, Cilium); other clusters store policies without effect.

### Scaling: read this before raising backend replicas

The backend keeps bookings in an **in-memory store**, so every replica owns a
separate set of seats and bookings. Two replicas would let a customer book a
seat on one pod and get a 404 for that reference on the other. That is why
`k8s/base/backend.yaml` pins `replicas: 1` and the backend HPA is parked in
`k8s/optional/` rather than the base kustomization.

To scale the API horizontally, replace `Store` in `backend/src/lib/store.ts`
with a database-backed implementation — Postgres with a unique index on
`(show_id, seat_id)` and the seat check plus insert inside one transaction —
then raise `replicas` and apply `k8s/optional/backend-hpa.yaml`. The class is
deliberately the only place that touches state, so nothing else has to change.

The frontend has no such constraint: it is stateless and ships with an HPA
(2–6 replicas on 75% CPU) and a PodDisruptionBudget in the base manifests.
