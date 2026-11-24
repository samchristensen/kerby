# AGENTS.md

This repository is the published `@kerby/sdk` (generated; do not edit `lib/`).

When asked to integrate a project with Kerby:

1. Read `INTEGRATION.md` (next to this file) completely before writing code: it names the pattern to use for each need and
   the mistakes to avoid.
2. Install the SDK from this repository at a tag in the target project, then read the types you will call in
   `lib/sdk/src/resources/*.d.ts` and the contracts in `lib/contracts/src/*.d.ts` (they carry the documentation).
3. Read `KERBY_BASE_URL` and `KERBY_API_KEY` once at startup and fail when missing. Never put the key in client-side
   code or logs.
4. Prove the integration against a running Kerby (the local stack's scripted model is enough): run the flow and watch a
   turn complete. Finish with the checklist at the end of INTEGRATION.md.
