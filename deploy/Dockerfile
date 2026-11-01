# Production images (Phase 10c). Build from the repository root:
#   docker compose -f deploy/compose.yml build
# Targets: `server` (runs the api, the worker, migrations and the admin commands) and `web` (Caddy with the built client).

# ---- Build everything: client bundle and server bundles ----
FROM node:22.23.2-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
COPY packages/content/package.json packages/content/
COPY packages/rules/package.json packages/rules/
COPY packages/shared/package.json packages/shared/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build

# ---- The server's runtime dependencies only (the @kots packages are bundled into dist) ----
FROM node:22.23.2-alpine AS server-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
COPY packages/content/package.json packages/content/
COPY packages/rules/package.json packages/rules/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev --workspace=@kots/server && mkdir -p apps/server/node_modules

# ---- api / worker / migrate / admin ----
FROM node:22.23.2-alpine AS server
ENV NODE_ENV=production
WORKDIR /app
COPY --from=server-deps /app/node_modules node_modules
COPY --from=server-deps /app/apps/server/node_modules apps/server/node_modules
COPY --from=build /app/apps/server/dist apps/server/dist
COPY apps/server/drizzle apps/server/drizzle
WORKDIR /app/apps/server
USER node
EXPOSE 4100
CMD ["node", "dist/api.cjs"]

# ---- Caddy: HTTPS, the client, and /api (with websockets) proxied to the api ----
FROM caddy:2.11.4-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/client/dist /srv
