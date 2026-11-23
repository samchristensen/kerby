# 0004. Prompts and the Studio

Goal: a tenant writes chat prompts and decision models in the console's Studio, versions and labels them, tries them in a
playground, and uses them by name and version from its own code and from the console's chat. Decisions: ADR 0017.

## Open questions (block the named milestone)

(none)

## Milestones

### P1 Library: `packages/prompts` and the api

- [x] `packages/prompts`: tenant migration, repo (create, list, get, save draft at a revision, publish, versions, labels,
  rename and delete before the first publish, resolve a number or label), `{{variable}}` parsing and rendering, publish
  checks; in `tenantMigrationDirs`; tests on real Postgres
- [x] api: `/v1/prompts` routes (ADR 0017), errors, limits, storage quota, audit; tests
- [x] `POST /v1/conversations { prompt }` pins `{ name, version }` and stores the rendered text; `POST /v1/judgments
  { state, prompt }`; both `GET`s return `prompt`; tests
- [x] Smoke on the real stack with `curl`

### P2 Editor

- [x] Spike: WYSIWYG markdown editors against prompt-shaped markdown (XML-like tags, `{{variables}}`, fenced code, GFM
  tables, nested lists); pick one; catalog pin, ADR 0005 line, ADR 0017 line
- [x] `MarkdownEditor` client component in the console, with a source mode

### P3 Studio (console)

- [x] Library tree of prompts and decision models; create; rename and delete before the first publish
- [x] Chat prompt editor (text, model, guardrails, variables), save with conflict detection, publish with a note, versions,
  labels
- [x] Decision model editor (noul, choice and score questions; model), publish, versions, labels
- [x] Playgrounds: chat (a real conversation, `studio:<userId>`), decision (a state as JSON, answers with probabilities)

### P4 Chat

- [x] New chat from a prompt name and version or label, with its variables; the thread shows `name@v<version>`

### P5 Close

- [x] ARCHITECTURE.md and docs current; `make check` and `make test` green; the whole path observed in a browser on
  `make up`

## Log

- 2026-11-22 Plan written with the owner's answers (ADR 0017): Studio in the console; draft, publish, versions and labels;
  chat prompt = text, model, guardrails; `{{variable}}` substitution; decision models = judgment definitions; a playground
  per kind; WYSIWYG editor with a tree. Contracts first: `packages/contracts/src/prompt-ref.ts`, `prompts.ts`;
  `CreateConversationRequestSchema.prompt`, `SubmitJudgmentRequestSchema`, `Conversation.prompt`, `Judgment.prompt`.
- 2026-11-22 P2: editor spike in Chromium on a 26-case prompt corpus (read back without editing). Milkdown Crepe 7.23
  (builder: no LaTeX, no images; `-` bullets, `---` rules): 22 identical, 4 normalized (table padding, `\` hard break,
  `&amp;`/`\#`/`\{` escapes), 0 lossy. Tiptap 3.34 + `@tiptap/markdown`: 11 identical, lossy on tags (`&lt;tag&gt;`),
  variables (`customer\_name`), comment, nested list. MDXEditor 4.5: 10 identical, fails to parse tags and autolinks,
  drops comments. Chose `@milkdown/crepe` + `@milkdown/kit` 7.23.0; `MarkdownEditor` in
  `services/console/src/app/_components/markdown-editor.tsx` (rich by default, Markdown source toggle, untouched text
  posts byte for byte, flushes on `formdata`); ~410 KB gzip, client-only, on pages that use it.
- 2026-11-22 P3, P4: Studio at `/dashboard/studio` (`src/service/studio.ts` over `/v1/prompts`, `/v1/conversations`,
  `/v1/judgments` with the session token; name as one `%2F`-encoded segment). Tree by `/` in Prompts and Decision models
  tabs; prompt page `studio/prompts/[...name]` with Draft, Versions (labels), Playground views. Editors build the body
  client-side and save it with the revision (`draft_conflict` offers a reload); publish waits for a save; the variables
  table follows `templateVariables` through a debounced server action (pages import no Kerby values). Chat playground
  renders a draft with `renderTemplate` in the service and sends it inline as `studio:<userId>`, a version as `prompt`;
  decision playground polls the judgment for at most 120 s. New chat "Start from" a published chat prompt; the thread
  shows `name@v<version>`; chat list origin `studio`. Service tests in `console.test.ts` (15 green).
- 2026-11-22 P1: `packages/prompts` (`prompts`, `prompt_versions`, `prompt_labels`; repo locks the prompt row for every
  write, publish = max+1 after revision, `publishProblems`, `unchanged`, limit and quota checks); `storedBytes` there is the
  one quota count (blob index + drafts + versions) for message posts and prompt writes; conversations `0005_prompts.sql`
  pins `prompt_name`/`prompt_version`; `run-judgment` params carry `prompt`, the worker passes only model/state/questions.
  api routes per ADR 0017, audit by prompt id; publish also refuses guardrail models that are not judgment providers (ADR
  0017 updated). `vitest run packages/prompts packages/conversations packages/contracts services/api services/worker`:
  136 green; control and durable 41 green.
- 2026-11-23 P1 smoke, P5: `make check` green, `make test` 391 green. `make up`, then `curl`: create, stale save 409
  `draft_conflict`, publish v1, 409 `unchanged`, v2, `production` -> v1, `latest` 400, render (default filled, missing 400
  `invalid_variables`), conversation from `production` pinned v1 and still v1 after the label moved to v2 (a turn ran),
  prompt with `system` 400, rename after publish 409, judgment from a decision prompt carried `prompt` through the worker,
  chat prompt as judgment 400 `wrong_kind`. Browser (signed up in the console): chat prompt typed in the rich editor and
  in Markdown, variables table, save, publish (stored text byte-identical), label, playground chat rendered and answered,
  decision model (choice question) created, published, playground answered by a stand-in System One server on a worker
  started with `KERBY_FAKE_MODEL=0 KERBY_TYPESAFE_BASE_URL` (90/10 bars, served model, tokens), refusal shown, bad JSON
  caught; new chat from `support/triage` at `production` with variables, thread shows `support/triage@v1`. Puppeteer's
  zero-delay typing scrambles a new list item (the first letter lands last); at 90 ms per key it does not. Tech-debt line
  added for the prompt gaps.
