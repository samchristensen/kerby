# Build from the repository root: docker build -f services/kerby/Dockerfile --target prod .
# One image for an install (ADR 0024): the launcher and the four services it runs, control, api, worker and dispatcher.
# There is no build step (Node runs the TypeScript directly), so an image is the sources plus their dependencies.
ARG NODE_VERSION=26.0.0
FROM node:${NODE_VERSION}-slim AS base
ARG PNPM_VERSION=10.33.2
WORKDIR /app
# Node 25+ no longer ships corepack: install the pnpm that `packageManager` in package.json names.
RUN npm install --global pnpm@${PNPM_VERSION}

FROM base AS sources
COPY . .

# dev: every dependency; each process restarts when its sources change (mount the sources over /app to edit live).
FROM sources AS dev
RUN pnpm install --frozen-lockfile --filter @kerby/kerby... --filter @kerby/control... --filter @kerby/api... --filter @kerby/worker... --filter @kerby/dispatcher...
ENV KERBY_WATCH=true
USER node
EXPOSE 8080
CMD ["node", "services/kerby/src/index.ts"]
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=5 \
  CMD ["node", "services/kerby/src/index.ts", "health"]

# prod: production dependencies only, as an unprivileged user.
FROM sources AS prod
RUN pnpm install --frozen-lockfile --prod --filter @kerby/kerby... --filter @kerby/control... --filter @kerby/api... --filter @kerby/worker... --filter @kerby/dispatcher...
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "services/kerby/src/index.ts"]
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=5 \
  CMD ["node", "services/kerby/src/index.ts", "health"]
