REGISTRY    ?= ghcr.io/nkurrado
TAG         ?= local
NAMESPACE   ?= movie-booking
BACKEND_IMG  = mtb-backend:$(TAG)
FRONTEND_IMG = mtb-frontend:$(TAG)

.PHONY: help install dev build images compose-up compose-down \
        deploy undeploy status logs forward render push

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
