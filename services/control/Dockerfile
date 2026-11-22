# Build from the repository root: docker build -f services/control/Dockerfile --target prod .
# There is no build step (Node runs the TypeScript directly), so an image is the sources plus their dependencies.
ARG NODE_VERSION=26.0.0
FROM node:${NODE_VERSION}-slim AS base
ARG PNPM_VERSION=10.33.2
WORKDIR /app
# Node 25+ no longer ships corepack: install the pnpm that `packageManager` in package.json names.
RUN npm install --global pnpm@${PNPM_VERSION}

# pg_dump for tenant export: it must be at least the server major version, which Debian's own package is not.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo $VERSION_CODENAME)-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && apt-get purge -y --auto-remove curl gnupg \
 && rm -rf /var/lib/apt/lists/*

# Tenant exports land here: mount a volume to keep them.
RUN mkdir -p /var/lib/kerby/exports && chown node:node /var/lib/kerby/exports

FROM base AS sources
COPY . .

# dev: every dependency, restarts on file changes (mount the sources over /app to edit live).
FROM sources AS dev
RUN pnpm install --frozen-lockfile --filter @kerby/control...
USER node
CMD ["node", "--watch", "services/control/src/index.ts"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8081/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# prod: production dependencies only, as an unprivileged user.
FROM sources AS prod
RUN pnpm install --frozen-lockfile --prod --filter @kerby/control...
ENV NODE_ENV=production
USER node
CMD ["node", "services/control/src/index.ts"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8081/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
