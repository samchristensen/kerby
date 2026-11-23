# 0019. Tools: remote MCP servers, granted to integrations, named by each conversation

- Status: proposed
- Date: 2026-11-23

## Context

A tenant's agent should act on the tenant's own systems. [ADR 0001](0001-platform-and-tenancy.md) set the frame: the
tenant registers remote MCP servers (a URL plus auth), no tenant code runs in Kerby, every call goes through the egress
guard ([ADR 0010](0010-egress-guard.md)), and credentials are sealed like model keys ([ADR 0008](0008-byok-sealed-secrets.md)).
Left open: who manages tools, from where, and who may use which. Three facts of the code shape the answer.

- An API key can do everything: `api_keys` has no scope, and the api's `Principal` is a tenant, an actor and limits. A key
  limited to some tools that can still call the routes that register and grant tools is not limited.
- A conversation belongs to the tenant, not to a key: any key may post to any conversation, and a turn does not know who
  posted the message that started it (`run-turn` params are `{ conversationId, seq }`).
- Only the worker can open a sealed secret. The api and the console hold the public key, so neither can call an MCP server
  that needs a credential, not even to list its tools.

Two more come from MCP. A server's tool descriptions go straight into the model's context, and the server may change them
at any time. Its annotations (`readOnlyHint`, `destructiveHint`) are hints the spec says to treat as untrusted. The current
revision, [2026-07-28](https://modelcontextprotocol.io/specification/versioning), is stateless (no `initialize`, no
session id); servers on 2025-11-25 and older still expect a session.

## Decision

- **An integration holds access; its keys belong to it.** A new control table `integrations` (tenant, a name unique among
  live ones, `role` `admin` or `restricted`, `archived_at`), and `api_keys.integration_id` (not null). The migration gives
  every tenant an `admin` integration named `default` holding its existing keys, so no existing key loses anything.
  Provisioning's first key, the operator's key routes and the console all make a key inside an integration; rotation makes
  the new key in the same one, so access never moves with a key. Archiving an integration revokes its keys.
  `authenticateApiKey` reads the integration with the key and the api caches both, so a role change lands within the auth
  cache window. A console session acts as `admin`. Who may create integrations and keys is unchanged from
  [ADR 0014](0014-tenant-console.md): a signed-in person in the console, and the operator.
  - `admin` may do everything the API offers and holds every tool.
  - `restricted` may create, post to, read and stream conversations (from a prompt too), submit and read judgments, and
    list its tools. Everything that changes the tenant's configuration (model keys, prompts, tool servers, grants) is
    403 `forbidden`. Least privilege; a route joins the list when a client needs it.
- **Tool servers and tools live in the tenant database** (a new `packages/tools`, `migrations/tenant/`).
  - `tool_servers`: `slug` (`[a-z0-9-]{1,24}`, unique, fixed once made; `kerby` is reserved), `url`, `auth` (`none`, or
    `header` with the header's name), sync status (`syncing`, `ready`, `error` with its reason) and `synced_at`.
  - `tools`, one row per server and tool name: the definition last listed, the **pinned** definition the model sees,
    `enabled` (false until an admin turns it on), `effect` (`read` or `write`: the tenant's call, `write` until set; the
    console pre-fills it from `readOnlyHint`), `drifted`, `removed_at`.
  - `integration_tools`, the grants: `(integration_id, server_id, tool)`, `tool` null for every enabled tool of the server;
    deleted with the server.
  - The model sees a tool as `<slug>__<tool>`. A tool whose name would not fit providers' `[A-Za-z0-9_-]{1,64}` cannot be
    enabled, and the console says why.
  - At most 20 servers per tenant, 200 tools kept per server, 64 tools per conversation: defaults until pricing.
- **A credential is sealed like a model key.** `PUT /v1/tool-servers/:slug/credential` (also accepted when a server is
  made) seals the header's value to `SECRETS_PUBLIC_KEY` into the control plane's `tenant_secrets` as
  `tool-credential/<serverId>`. The name is authenticated data and carries the server's id, so a deleted server's leftover
  secret can never open for a new server under the same slug. Printable ASCII without CR or LF, at most 4 KiB, never
  returned; the header may not be one the transport sets (`Host`, `Content-*`, `Accept`, `Mcp-*`, hop-by-hop). A server
  with a credential must use https. Only the worker opens it, inside the step that uses it, and scrubs it from errors as
  it does a model key.
- **The worker lists tools; nothing else can.** Making a server, changing its URL or credential, or
  `POST /v1/tool-servers/:slug/sync` enqueues a `sync-tool-server` task on the `turns` queue (the only queue workers
  claim; like a judgment it counts against concurrent turns). The worker opens the credential and calls `tools/list`
  through `createEgressFetch` (30 s, 1 MiB), then:
  - a new tool arrives disabled, pinned to what was listed;
  - a disabled tool's pinned definition follows the listing;
  - an enabled tool whose definition changed keeps its pinned one and is `drifted` until an admin accepts the new one
    (`PATCH .../tools/:name { acceptDefinition: true }`): **the model never sees a definition no admin enabled**;
  - a tool missing from the listing gets `removed_at` and is not offered.

  Nothing syncs on a schedule yet.
- **Tools are explicit.** `POST /v1/conversations { tools: ["github/*", "zendesk/search_tickets", "kerby/judge"] }`; with
  no `tools`, none are offered. A chat prompt ([ADR 0017](0017-prompts.md)) carries `tools` and sets them with the system
  prompt, model and guardrails. The api resolves each pattern to a server id when the conversation is made (an unknown
  server or tool is 400 `unknown_tool`) and stores ids, so a server deleted and made again under the same slug is not the
  old conversation's. `<slug>/*` covers the server's tools that are enabled at each turn.
- **The poster must hold every tool the conversation names.** Creating a conversation and posting a message check, in the
  same tenant transaction, that the caller's grants cover the conversation's tools (`<slug>/*` needs a grant for the whole
  server); otherwise 403 `tool_not_granted`, naming the patterns. So a restricted integration cannot push a conversation
  someone else started into tools it was not given, a narrowed grant applies from its next message, and a turn needs no
  record of who posted.
- **Built-ins are tools like any other.** The reserved server `kerby` serves Kerby's own tools from code: `judge` (when
  the tenant has a key for the default judgment provider, [ADR 0015](0015-judgment-port.md)) and `echo` (development).
  They need no enabling, but a grant and a conversation's pattern like the rest; ADR 0015's implicit offer of `judge`
  ends. A new Kerby capability ships as a `kerby/<name>` tool.
- **A turn's tools** are the conversation's tools that are enabled, not removed and available now, at most 64 (past that
  the turn ends with `last_error`). The worker calls a remote tool inside its `tool:<callId>` step, after the guardrails
  ([ADR 0016](0016-guardrails.md)): through `createEgressFetch` with 60 s per call, a session per server per run only for
  servers older than 2026-07-28, the call id in `_meta` for servers that deduplicate, and no client capabilities (no
  sampling, roots or elicitation: a server cannot spend the tenant's model key or ask a person anything). Text and
  `structuredContent` (as JSON text) reach the model; other content becomes a note naming its kind; a result is cut at
  256 KiB with a note. An egress refusal, a timeout, an HTTP or MCP error is an error result the model reads, not a turn
  retry; on a `write` tool a timeout or broken connection says the call may have taken effect.
- **The interrupted-write rule.** `recordToolExecution` counts runs inside the step. When it finds an earlier execution
  (an attempt began the call and never stored a result), a `write` tool is not called again: the model gets an error
  result saying the call was interrupted and may or may not have taken effect. A `read` tool runs again. A tool's
  `ToolSpec.readOnly` is its effect.
- **Tools are managed through the API, and the console uses the same routes.** Admin: `POST`/`GET /v1/tool-servers`,
  `GET`/`PATCH`/`DELETE /v1/tool-servers/:slug`, `PUT /v1/tool-servers/:slug/credential`,
  `POST /v1/tool-servers/:slug/sync`, `PATCH /v1/tool-servers/:slug/tools/:name` (`enabled`, `effect`,
  `acceptDefinition`), `GET`/`PUT /v1/integrations/:id/tools` (the grants; `kerby_app` reads `integrations` to check the
  id is the tenant's). Any caller: `GET /v1/tools`, the tools it may use, with descriptions and schemas, so a client can
  name them. The console calls these with the person's session token, as the Studio does, and adds Tools pages (servers,
  credential, sync, enable, effect, drift review, the integrations granted), an Integrations page in place of API keys
  (role, keys, grants) and a tool picker in chat and the Studio. Every change is audited (`tool_server.*`, `tool.update`,
  `integration.*`) with ids and slugs only.
- **OAuth comes next, on the same tables.** `auth: oauth` per MCP's authorization spec: a callback in the console, PKCE,
  the `resource` parameter, the issuer check, a Client ID Metadata Document Kerby publishes with dynamic registration where
  a server lacks it, and discovery and token calls through egress. Tokens are sealed under the server's secret name; the
  worker refreshes them under a row lock on that secret, since two workers refreshing at once would revoke each other's
  token. A credential belongs to the tenant, not to an end user.
- **The MCP client sits behind one package**, `packages/mcp`: Streamable HTTP over a `fetch` it is given (egress).
  Wrapping an SDK or writing it on `fetch` is decided with its [ADR 0005](0005-dependencies.md) line:
  `@modelcontextprotocol/sdk` 1.32.2 speaks at most 2025-11-25, and the 2.x client (`@modelcontextprotocol/client` 2.4.0)
  was not checked against 2026-07-28.
- Rejected:
  - Grants on keys (restricted keys): rotation makes a new key here (`rotateKey`), so every rotation would have to copy
    them, and one client with two keys could hold two policies. (owner's call)
  - Tools a conversation gets without naming them, such as every tool granted: a new grant or a newly enabled tool would
    silently widen what existing conversations can do. (owner's call)
  - Disabling an enabled tool whose definition changed: safer, but one vendor's wording edit would stop a tenant's agents;
    pinning keeps the model on reviewed text, which is how a description does harm. (owner's call)
  - Fixing each turn's tools from the poster's grants (a copy in `run-turn`): a conversation would quietly lose tools
    depending on who wrote last; refusing the post says why.
  - Grants and conversation tools as slug strings in the control plane: a slug made again would inherit old grants and
    conversations.
  - Listing tools from the api: it cannot open a credential, and giving it the private key undoes ADR 0008.
  - Kerby as an MCP gateway (an integration calling tools directly): the same grants would serve, but a call needs the
    private key, which only workers hold. It needs its own ADR.

## Consequences

- Existing keys keep full access (`default`, `admin`); a narrower client needs a new integration and new keys.
- A conversation that relied on `judge` being offered no longer gets it until it names `kerby/judge`. The fake model
  asks for `kerby__echo` instead of `echo`, and the conversations of `make e2e` and the worker's tests name `kerby/echo`.
- A restricted integration still reads every conversation of its tenant: grants limit what its turns can do, not what it
  can see. Per-integration visibility is not built.
- A tool's output is untrusted text in the model's context, and guardrails do not read it (ADR 0016).
- A `write` tool cut off by a crash is reported, not repeated: the model, and through it the user, may have to check.
- A failing remote tool is the model's to handle; the turn does not retry it.
- The egress guard refuses the Compose network, so the proof on the real stack needs an MCP server the guard lets
  through. Plan 0001 holds that question.
- One credential per server for the whole tenant: end users who each need their own account are not served yet.
