# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- build stage
FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

# -------------------------------------------------------------- runtime stage
# The unprivileged image listens on 8080 and runs as a non-root user already.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

# Where nginx forwards /api. Overridden per environment.
ENV BACKEND_URL=http://mtb-backend:80 \
    NGINX_ENVSUBST_FILTER='^(BACKEND_URL|DNS_RESOLVER)$'

COPY --chown=nginx:nginx nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --chown=nginx:nginx nginx/10-resolver.envsh /docker-entrypoint.d/10-resolver.envsh
COPY --from=build --chown=nginx:nginx /app/dist /usr/share/nginx/html

# The entrypoint skips .envsh hooks that are not executable.
USER root
RUN chmod +x /docker-entrypoint.d/10-resolver.envsh
USER nginx
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/bin/sh", "-c", "wget -qO- http://127.0.0.1:8080/healthz > /dev/null || exit 1"]
