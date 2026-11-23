# 0017. Prompts: named, versioned instructions in the tenant's database, edited in the console's Studio

- Status: proposed
- Date: 2026-11-22

## Context

A tenant writes its system prompts and judgment questions into every request (`system`, `guardrails`, `questions`), so
the words that steer its agents live in its client code, unversioned, and change only with a deploy. The owner wants
them managed: written in a rich markdown editor, versioned, labelled, tried out in the console, and used by clients and
the console's chat by name and version. The owner decided (2026-11-22): a Studio section of the console, not a service of
its own; draft then publish, versions 1 to N, labels that move; a chat prompt fixes its text, model and guardrails;
`{{variable}}` substitution and no template language; "decision models" are System One judgment definitions (ADR 0015);
testing is a playground for each kind; the editor is WYSIWYG with a tree of prompts by name.

## Decision

- **One resource, two kinds**: `chat` (a system prompt in markdown, its variables, model and guardrails) and `decision` (the
  questions and model of a judgment; the Studio calls these decision models). One lifecycle serves both: a name unique in
  the tenant, one draft, immutable versions, labels. Tables in the tenant database, owned by `packages/prompts`
  (`migrations/tenant/`); schemas in `packages/contracts` (`prompts.ts`, and `prompt-ref.ts` for how other requests name
  a prompt). Bodies are JSON in Postgres, not S3: at most 100 000 characters of text, read when a conversation is made,
  and written in the same transaction as the version row.
- **Names are the client contract.** `support/triage`: up to five lowercase segments joined by `/`, shown as folders.
  Renaming and deleting are allowed only before the first publish; after that a client may depend on the name.
- **Draft, publish, label.** The draft carries a revision; a save and a publish name the revision they started from, or
  get 409 `draft_conflict`, so two editors never overwrite each other unseen and a publish freezes what the person saw.
  Publishing checks the draft (400 `not_publishable`, every problem listed): a chat prompt has text, declares exactly the
  `{{names}}` its text uses, and names a chat model if any (and judgment models for its guardrails, if they name one); a
  decision prompt asks 1 to 32 questions and names a judgment model if any. Whether the tenant holds a key for a model is
  checked when the prompt is used, not at publish. A draft identical to the latest version is 409 `unchanged`. Versions
  are never changed or deleted. A label points at one version and moves; `latest` is implied, always the highest, and
  cannot be set (400 `invalid_request`).
- **Using a prompt**: a name and a `version`, a number or a label. `GET /v1/prompts/:name/versions/:version` returns the
  version; `POST .../render` fills a chat prompt's variables; `POST /v1/conversations` takes `prompt` (it sets system,
  model and guardrails, so none of those may come with it) and `POST /v1/judgments` takes `{ state, prompt }`. A label is
  resolved once, when the conversation or judgment is made, and the result records `prompt: { name, version }`: moving a
  label never changes an existing conversation, whose system prompt and guardrails are fixed at creation (ADR 0016). The
  conversation stores the rendered text as before, so a turn never reads the prompt tables.
- **Variables** are `{{name}}` (spaces inside the braces allowed) in a chat prompt's text, declared with an optional
  description and default; a value is a string put in verbatim. No escaping, conditions, loops or helpers: logic written by
  a tenant does not run in Kerby's processes. A variable without a default must be given; an undeclared one is refused
  (400 `invalid_variables`); the rendered text is at most 100 000 characters, like any system prompt.
- **Bounded**: at most 1 000 prompts per tenant and 1 000 versions per prompt (409 `prompt_limit`); draft and version bodies
  count against `limits.storageBytes` with the blob index (413 `storage_quota_exceeded`).
- **API keys and console sessions alike.** The routes are part of the public API, so a tenant can sync prompts from its own
  repository. A version records who published it (`key:<id>` or `user:<id>`); publishing and moving labels are audited in
  the control plane by prompt id, never by name, which is the tenant's words.
- **The Studio** (`/dashboard/studio`) lists prompts and decision models as a tree, edits a draft (a WYSIWYG markdown editor
  for a chat prompt's text, forms for the model, guardrails, variables and questions), publishes with a note, shows versions
  and moves labels. Each kind has a playground: a chat prompt (draft or version) opens a real conversation marked
  `studio:<userId>`, on the tenant's keys and counted like any chat; a decision prompt runs a judgment on a state pasted as
  JSON and shows every answer's probabilities. The new-chat form can start from a prompt name and version, asking for its
  variables; the thread shows `name@v<version>`. The console reaches all of it through the api with the person's session
  (ADR 0014), as it does chats.
- **The editor stores markdown**: it loads and saves markdown, keeps what a prompt is made of (XML-like tags such as
  `<instructions>`, `{{variables}}`, fenced code, GFM tables) and has a source mode for anything the rich view cannot show.
  The spike (plan 0004, P2) chose Milkdown Crepe (`@milkdown/crepe`, ADR 0005): on a 26-case prompt corpus nothing was
  lost (tags, variables, code, comments, `$`, nested lists intact), 22 cases came back byte for byte and 4 normalized
  without changing meaning (aligned table padding, `\` hard break, entities and escapes). Tags show verbatim in the rich
  view and are edited in source mode; an untouched document is saved byte for byte, an edited one is serialized by remark.
- Rejected: a Studio service of its own (a second sign-in, session and deployment for the same people); semantic versions
  (range rules nobody asked for); a template language (tenant logic in our process); bodies in S3 (small, transactional,
  read on the request path); a table per kind (two copies of one lifecycle); resolving a label at every turn (a moved label
  would change a running conversation).

## Consequences

- `Conversation.prompt` and `Judgment.prompt` are new fields; requests without `prompt` behave as before.
- Not built: real-time co-editing, comments, a diff view, deleting or renaming a published prompt, saved test cases and
  datasets, prompts in the agent's `judge` tool. Each is a later change on the same tables.
- Prompt bodies share the tenant's storage quota with message bodies: a tenant near its quota cannot save a draft.
- The console's bundle gains an editor library.

## Amendment: chat prompts name tools (2026-11-23)

A chat body carries `tools`, the patterns a conversation started from it may call (ADR 0022); a conversation from a prompt
takes them with the system prompt, model and guardrails, so a request naming a prompt may not also name `tools`. They are
resolved when the conversation is made, so a prompt names servers by slug and a server deleted since is a 400. Bodies
stored before carry an empty list (tenant migration `prompts/0002_tools.sql`): none named, none offered.
