# 0025. Public repository, MIT license, the SDK on npm

- Status: accepted (the owner's call, 2026-11-24)
- Date: 2026-11-24

## Context

Kerby started private because it was meant to be sold as a service, and because a registry for the SDK looked like one
more thing to run for one set of consumers ([0023](0023-sdk.md)). With installs of a project's own
([0024](0024-self-hosted-single-tenant.md)) and an owner who wants to build in public and have developer friends try it,
the privacy bought nothing and cost every consumer: the SDK lived in a second private repository, so each project's
lockfile recorded an SSH address, every CI or Docker build needed a key or token (and `git`, which the `node:*-slim`
images lack), npm 12 refuses git dependencies unless told otherwise, and the images needed a `docker login`.

## Decision

- **Both repositories become public**, under `samchristensen`. The second one, `kerby-sdk`, is deleted: with nothing
  private left, a generated mirror has no job.
- **MIT** (`LICENSE`): the most permissive widely understood license, copyright Sam Christensen.
- **`@samchristensen/kerby-sdk` is published to the public npm registry by CI** on every merge to `main`, from this repository
  (`make sdk-publish`, [scripts/sdk.ts](../../scripts/sdk.ts)). The script builds as the latest published version and
  compares the packed bytes with the registry's; only a difference publishes, as the next patch of the
  `<major>.<minor>` line in `packages/sdk/package.json` (nobody bumps patches). The credential is **npm trusted
  publishing**: the package names this repository and `ci.yml` as its publisher and the `sdk` job proves it with an OIDC
  token, so no npm token exists to store or leak, and npm records each version's commit as provenance.
- **The package is `@samchristensen/kerby-sdk`**, not `@kerby/sdk`: the `@kerby` scope on npm belongs to another account.
  The workspace keeps its internal name `@kerby/sdk`; only the published manifest (`NAME` in `scripts/sdk.ts`) differs. npm
  binds a trusted publisher to a package that already exists (it answers `404 Package not found` otherwise), so `0.1.0` is
  published once by hand and every later version by CI.
- **Images** stay `ghcr.io/samchristensen/kerby` and `kerby-console`. A GHCR package's visibility is its own setting
  after its first push; the console's, created while the repository was private, is changed there.
- **Reports** go through GitHub private vulnerability reporting ([SECURITY.md](../../SECURITY.md)).

## Alternatives

- _A public SDK repository only, installed `github:`_: removes the token, not the git dependency: npm 12 blocks it by
  default and a Docker build still needs `git`.
- _A private npm registry (paid scope, or GitHub Packages)_: every consumer keeps a token, which is the friction this
  removes.
- _A restrictive license (AGPL, BSL, FSL)_ to keep hosting Kerby as a service to oneself: rejected for now; the owner wants
  the least friction for people trying it. A later license applies to later code; what was released stays MIT.

## Consequences

- Anything pinned to `github:samchristensen/kerby-sdk#v…` stops resolving; install `@samchristensen/kerby-sdk` from npm. Versions restart
  on the registry at `0.1.0` (the git tags `v0.1.0` and `v0.1.1` went with the repository).
- The whole history is public. It was scanned with gitleaks before the change: the findings were test fixtures and keys
  labelled development-only in old `compose.yaml` revisions. Nothing depends on the source being secret: tenant secrets are
  sealed with keys derived from `KERBY_SECRET_KEY`, which no file holds.
- The `SDK_DEPLOY_KEY` secret and the SDK repository's deploy key are unused and removed.
- Selling Kerby as a service later (a plan of its own, from tag `saas-poc`) starts from an MIT codebase that anyone may
  also host.
