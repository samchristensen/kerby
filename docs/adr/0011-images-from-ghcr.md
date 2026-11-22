# 0011. CI builds the images; Railway runs them from GHCR

- Status: proposed
- Date: 2026-11-22

## Context

[ADR 0007](0007-railway-hosting.md) had Railway build each service from its Dockerfile, fed by `railway up` from a
laptop: what shipped was whatever was on disk (`+dirty` included), nothing gated it, and Railway's builder, not CI, decided
what an image held. There was no remote and no CI. Plan 0003 (C1, C5) asks for a gate before anything ships.

## Decision

- **GitHub is the remote; Actions is CI** (`.github/workflows/ci.yml`). Every pull request and every push to `main` runs
  `make check`, `make test` and builds the three images. `main` is protected: `check` and `test` must pass to merge.
- **CI builds the images** from `services/<name>/Dockerfile` (stage `prod`, `linux/amd64`) and, on `main`, pushes them to
  GHCR as `ghcr.io/samchristensen/kerby-<service>:sha-<commit>` (and `:main`). The packages are private and linked to
  the repository. Pull requests build without pushing.
- **Railway builds nothing.** Each service's source is the image `kerby-<service>:<environment>` (`.railway/railway.ts`,
  using the environment name Railway passes to the file). A release points that tag at `sha-<commit>`
  (`docker buildx imagetools create`) and redeploys from source (`railway redeploy --from-source`), control first, then
  api and worker (`scripts/railway.ts deploy`, `make deploy ENV= TAG=`). Rolling back is deploying an older `sha-` tag.
- **Release on merge.** After `check`, `test` and `images` pass on `main`, the `release` job applies the IaC file to
  production (additions and changes only; a deletion fails the job and needs a person), refreshes the services' GHCR pull
  credentials, and rolls the commit's images out. One release at a time.
- **Credentials.** CI holds `RAILWAY_TOKEN`, a Railway project token scoped to `production` (the CLI login cannot mint one:
  `projectTokenCreate` answers "Not Authorized"), and `GHCR_PULL_TOKEN`, a classic GitHub token with `read:packages`
  only, which Railway uses to pull the private images. Pushing uses the workflow's own `GITHUB_TOKEN`.
- **Pull requests** get a Railway plan of the IaC change in their checks (`railway-plan`).
- **Preview environments stay manual.** A project token is scoped to one environment and cannot create another, and an
  account token can do everything the login can. A person or agent with the login runs `make railway-setup ENV=<name>`
  and `make deploy ENV=<name> TAG=sha-<commit>` for an image CI built, and `make env-down ENV=<name>` after.
- Rejected: Railway building from a GitHub connection (Railway, not CI, would decide what ships, and the gate would be
  Railway's); public images (the images hold the source); `railway config apply` deploying a tag written into the file
  (every environment would drift on every release, and the order control, api, worker would be lost).

## Consequences

- What runs is exactly what CI tested, by digest; Railway's build minutes go away.
- A push to `main` is a production release. A broken release is fixed forward or rolled back with `make deploy TAG=`.
- GHCR storage for private packages counts against the account's quota; old `sha-` versions need pruning as they grow.
- Two tokens are created by hand once (docs/deploy.md, CI) and live as repository secrets.
