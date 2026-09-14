REGISTRY    ?= ghcr.io/nkurrado
TAG         ?= local
NAMESPACE   ?= movie-booking
BACKEND_IMG  = mtb-backend:$(TAG)
FRONTEND_IMG = mtb-frontend:$(TAG)

DOCR_REPO ?= registry.digitalocean.com/managed-agents-demo/movie-ticket-booking

.PHONY: help install dev build images compose-up compose-down \
        deploy undeploy status logs forward render push \
        doks-images doks-deploy doks-undeploy

help: ## Show available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies for both services
	cd backend && npm install
	cd frontend && npm install

dev: ## Run both services locally with hot reload (needs two terminals)
	@echo "Terminal 1: cd backend  && npm run dev   # http://localhost:4000"
	@echo "Terminal 2: cd frontend && npm run dev   # http://localhost:5173"

build: ## Type-check and build both services
	cd backend && npm run build
	cd frontend && npm run build

images: ## Build both container images
	docker build -t $(BACKEND_IMG) ./backend
	docker build -t $(FRONTEND_IMG) ./frontend

push: ## Tag and push images to $(REGISTRY)
	docker tag $(BACKEND_IMG)  $(REGISTRY)/$(BACKEND_IMG)
	docker tag $(FRONTEND_IMG) $(REGISTRY)/$(FRONTEND_IMG)
	docker push $(REGISTRY)/$(BACKEND_IMG)
	docker push $(REGISTRY)/$(FRONTEND_IMG)

compose-up: ## Run the full stack with Docker Compose on :8080
	docker compose up --build -d

compose-down: ## Stop the Compose stack
	docker compose down

render: ## Print the rendered dev manifests without applying
	kubectl kustomize k8s/overlays/dev

deploy: images ## Build images and apply the dev overlay
	kubectl apply -k k8s/overlays/dev
	kubectl -n $(NAMESPACE) rollout status deploy/mtb-backend
	kubectl -n $(NAMESPACE) rollout status deploy/mtb-frontend

undeploy: ## Delete everything from the cluster
	kubectl delete -k k8s/overlays/dev --ignore-not-found

status: ## Show pods, services and ingress
	kubectl -n $(NAMESPACE) get pods,svc,ingress

logs: ## Tail backend logs
	kubectl -n $(NAMESPACE) logs -l app.kubernetes.io/name=mtb-backend -f --tail=100

forward: ## Forward the frontend Service to http://localhost:8080
	kubectl -n $(NAMESPACE) port-forward svc/mtb-frontend 8080:80

# --------------------------------------------------------------------- DOKS

doks-images: ## Cross-build linux/amd64 images and push them to DOCR
	doctl registry login
	docker buildx build --platform linux/amd64 -t "$(DOCR_REPO):backend-1.0.0"  --push ./backend
	docker buildx build --platform linux/amd64 -t "$(DOCR_REPO):frontend-1.0.0" --push ./frontend

doks-deploy: ## Create the pull secret and apply the DOKS overlay
	kubectl apply -f k8s/base/namespace.yaml
	doctl registry kubernetes-manifest --namespace $(NAMESPACE) | kubectl apply -f -
	kubectl apply -k k8s/overlays/doks
	kubectl -n $(NAMESPACE) rollout status deploy/mtb-backend
	kubectl -n $(NAMESPACE) rollout status deploy/mtb-frontend
	@echo "Load balancer IP:"
	@kubectl -n ingress-nginx get svc ingress-nginx-controller \
		-o jsonpath='{.status.loadBalancer.ingress[0].ip}{"\n"}'

doks-undeploy: ## Remove the app from DOKS (leaves ingress-nginx in place)
	kubectl delete -k k8s/overlays/doks --ignore-not-found

# Detected at run time so a changed home IP is picked up automatically.
# Override explicitly with: make doks-allow-ip ALLOW_CIDR=203.0.113.7/32
ALLOW_CIDR ?= $(shell curl -4 -sS https://api.ipify.org)/32

doks-allow-ip: ## Restrict the load balancer to ALLOW_CIDR (defaults to your current IP)
	@echo "Restricting load balancer to $(ALLOW_CIDR)"
	kubectl -n ingress-nginx patch svc ingress-nginx-controller --type merge \
		-p '{"spec":{"loadBalancerSourceRanges":["$(ALLOW_CIDR)"]}}'
	@echo "DigitalOcean takes ~30s to apply the firewall rule."

doks-open: ## Remove the IP restriction and expose the app to the internet again
	kubectl -n ingress-nginx patch svc ingress-nginx-controller --type json \
		-p '[{"op":"remove","path":"/spec/loadBalancerSourceRanges"}]'

doks-show-firewall: ## Print the load balancer's active firewall rules
	@kubectl -n ingress-nginx get svc ingress-nginx-controller \
		-o jsonpath='{.spec.loadBalancerSourceRanges}{"\n"}'
