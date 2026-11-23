# Build from the repository root: docker build -f services/dispatcher/Dockerfile --target prod .
# There is no build step (Node runs the TypeScript directly), so an image is the sources plus their dependencies.
ARG NODE_VERSION=26.0.0
FROM node:${NODE_VERSION}-slim AS base
ARG PNPM_VERSION=10.33.2
WORKDIR /app
# Node 25+ no longer ships corepack: install the pnpm that `packageManager` in package.json names.
RUN npm install --global pnpm@${PNPM_VERSION}

FROM base AS sources
COPY . .

# dev: every dependency, restarts on file changes (mount the sources over /app to edit live).
FROM sources AS dev
RUN pnpm install --frozen-lockfile --filter @kerby/dispatcher...
USER node
CMD ["node", "--watch", "services/dispatcher/src/index.ts"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8083/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# prod: production dependencies only, as an unprivileged user.
FROM sources AS prod
RUN pnpm install --frozen-lockfile --prod --filter @kerby/dispatcher...
ENV NODE_ENV=production
USER node
CMD ["node", "services/dispatcher/src/index.ts"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8083/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
