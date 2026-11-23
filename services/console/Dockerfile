# Build from the repository root: docker build -f services/console/Dockerfile --target prod .
# The one service with a build step (ADR 0014): `next build` compiles the pages in src/app; Node runs everything else as
# TypeScript, as in the other services.
ARG NODE_VERSION=26.0.0
FROM node:${NODE_VERSION}-slim AS base
ARG PNPM_VERSION=10.33.2
WORKDIR /app
# Node 25+ no longer ships corepack: install the pnpm that `packageManager` in package.json names.
RUN npm install --global pnpm@${PNPM_VERSION}
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS sources
COPY . .

# dev: every dependency; Next.js compiles on request and reloads (mount the sources over /app to edit live).
FROM sources AS dev
RUN pnpm install --frozen-lockfile --filter @kerby/console... && chown -R node:node services/console
ENV DEV_SERVER=true
USER node
CMD ["node", "services/console/src/index.ts"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# build: compile the pages (Tailwind and the type packages are build dependencies only).
FROM sources AS build
RUN pnpm install --frozen-lockfile --filter @kerby/console...
RUN cd services/console && pnpm exec next build

# prod: production dependencies and the compiled pages, as an unprivileged user (Next.js may write its cache).
FROM sources AS prod
RUN pnpm install --frozen-lockfile --prod --filter @kerby/console...
COPY --from=build --chown=node:node /app/services/console/.next services/console/.next
ENV NODE_ENV=production
USER node
CMD ["node", "services/console/src/index.ts"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
