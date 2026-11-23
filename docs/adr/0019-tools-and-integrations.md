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
    list its tools (`GET /v1/tools`). Every other route is 403 `forbidden`, the message naming the role and what it may
    call. Least privilege; a route joins the list when a client needs it.
- **Tool servers and tools live in the tenant database** (a new `packages/tools`, `migrations/tenant/`).
  - `tool_servers`: `slug` (`[a-z0-9-]{1,24}`, unique, fixed once made; `kerby` is reserved), `url`, `auth` (`none`, or
    `header` with the header's name), sync status (`syncing`, `ready`, `error` with its reason) and `synced_at`.
  - `tools`, one row per server and tool name: the definition last listed, the **pinned** definition the model sees,
    `enabled` (false until an admin turns it on), `effect` (`read` or `write`: the tenant's call, `write` until set; the
    console shows the server's `readOnlyHint` beside the choice, as a hint only), `drifted`, `removed_at`.
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
  through `createEgressFetch` (30 s and 1 MiB a page; at most 200 tools and 4 MiB a listing, stopped as soon as either
  is past, so a tenant's server cannot fill a shared worker's memory; an input schema is at most 64 KiB), then:
  - a new tool arrives disabled, pinned to what was listed;
  - a disabled tool's pinned definition follows the listing;
  - an enabled tool whose definition changed keeps its pinned one and is `drifted` until an admin accepts the new one
    (`PATCH .../tools/:name { acceptDefinition: true }`): **the model never sees a definition no admin enabled**;
  - a tool missing from the listing gets `removed_at` and is not offered.

  A listing is fenced: it is recorded only if the server's `updated_at` (moved by every change of URL, auth, credential
  or a sync request) is still what it was when the listing began, so a slow listing of an old URL or credential never
  overwrites a newer one. A failure before listing (the credential could not be read) retries, and the last attempt
  records the error, so a server never stays `syncing`. Enabling or accepting may carry `expectedDefinition` (the
  `listedHash` the admin was shown; the console always sends it): when the server lists something else by then, 409
  `definition_changed`. Nothing syncs on a schedule yet.
- **Tools are explicit.** `POST /v1/conversations { tools: ["github/*", "zendesk/search_tickets", "kerby/judge"] }`; with
  no `tools`, none are offered. A chat prompt ([ADR 0017](0017-prompts.md)) carries `tools` and sets them with the system
  prompt, model and guardrails. The api resolves each pattern to a server id when the conversation is made (an unknown
  server or tool is 400 `unknown_tool`) and stores ids, so a server deleted and made again under the same slug is not the
  old conversation's. `<slug>/*` covers the server's tools that are enabled at each turn.
- **The poster must hold every tool the conversation names.** Creating a conversation and posting a message check, before
  anything is stored, that the caller's grants cover the conversation's tools (`<slug>/*` needs a grant for the whole
  server); otherwise 403 `tool_not_granted`, naming the patterns. So a restricted integration cannot push a conversation
  someone else started into tools it was not given, a narrowed grant applies from its next message, and a turn needs no
  record of who posted.
- **Built-ins are tools like any other.** The reserved server `kerby` serves Kerby's own tools from code: `judge` (when
  the tenant has a key for the default judgment provider, [ADR 0015](0015-judgment-port.md)) and `echo` (development).
  They need no enabling, but a grant and a conversation's pattern like the rest; ADR 0015's implicit offer of `judge`
  ends. A new Kerby capability ships as a `kerby/<name>` tool.
- **A turn's tools** are the conversation's tools that are enabled, not removed and available now, at most 64 (past that
  the turn ends with `last_error`). The worker calls a remote tool inside its `tool:<callId>` step, after the guardrails
  ([ADR 0016](0016-guardrails.md)): through `createEgressFetch`, `TOOL_CALL_TIMEOUT_MS` (60 s) per call, one MCP session
  per server per run opened on first use, the call id in `_meta` (`kerby/callId`) for servers that deduplicate, and no
  client capabilities (no sampling, roots or elicitation: a server cannot spend the tenant's model key or ask a person
  anything). Text and `structuredContent` (as JSON text) reach the model; other content becomes a note naming its kind; a
  result is cut at 256 KiB with a note (a response is read up to 4 MiB), an error result at 16 KiB. An egress refusal, a
  timeout, an HTTP or MCP error is an error result the model reads, not a turn retry; on a `write` tool a failure after
  the server took the request (a timeout, a broken connection or stream, a malformed answer, HTTP 502/503/504) says the
  call may have taken effect. Kerby never follows a redirect from a tenant's MCP server (a credential in a custom header
  would go with it): a 3xx is an error naming where it pointed. A credential `<scheme> <token>` is scrubbed whole and as
  its token; an address the guard refused is named by host only, never by the private address it resolved to.
- **The interrupted-write rule.** `recordToolExecution` counts runs inside the step. When it finds an earlier execution
  (an attempt began the call and never stored a result), a `write` tool is not called again: the model gets an error
  result saying the call was interrupted and may or may not have taken effect. A `read` tool runs again. A tool's
  `ToolSpec.readOnly` is its effect.
- **Tools are managed through the API, and the console uses the same routes.** Admin: `POST`/`GET /v1/tool-servers`,
  `GET`/`PATCH`/`DELETE /v1/tool-servers/:slug`, `PUT /v1/tool-servers/:slug/credential`,
  `POST /v1/tool-servers/:slug/sync`, `PATCH /v1/tool-servers/:slug/tools/:name` (`enabled`, `effect`,
  `acceptDefinition`), `GET /v1/integrations`, `GET`/`PUT /v1/integrations/:id/tools` (the grants; `kerby_app` reads
  `integrations` to check the id is the tenant's). Any caller: `GET /v1/tools`, the tools it may use, with descriptions
  and schemas, so a client can name them. Refusals: 400 `unknown_tool` (with `problems`), `too_many_tools`,
  `tool_not_usable`, `builtin_tool_server`; 403 `tool_not_granted`; 409 `tool_server_exists`, `tool_server_limit`. The
  console calls these with the person's session token, as the Studio does, and adds Tools pages (servers, credential,
  sync, enable, effect, drift review, the integrations granted), an Integrations page in place of API keys (role, keys,
  grants) and a tool picker in chat and the Studio. Every change is audited (`tool_server.*`, `tool.update`,
  `integration.*`) with ids, slugs, patterns and a server URL's origin only (some servers put a secret in the path).
- **Schema n-1 is tolerated.** A tenant whose tool migration has not run yet answers as one with no tools: reads of an
  empty tool list run no query, and `listConversationTools` treats a missing table as none.
- **OAuth, for the whole tenant** (`auth: { kind: "oauth", scope? }`), per MCP's authorization spec (2026-07-28). An
  admin starts it (`POST /v1/tool-servers/:slug/oauth/start` → `{ authorizationUrl }`; the console's Connect button): the
  api, through egress and never following a redirect, finds the protected resource metadata (the 401's
  `resource_metadata`, else the RFC 9728 well-known URIs; its `resource` must be the server's URL or a path prefix of it),
  the authorization server's metadata (RFC 8414 or OpenID discovery, the issuer exactly as asked), and a client id: Kerby's
  Client ID Metadata Document (`<console>/oauth/client-metadata.json`, served by the console without a session) when the
  server supports it and the console is https, else dynamic registration (a public client preferred; a secret kept if one
  is issued). PKCE S256 is required. The pending flow is a row of the tenant's `tool_oauth_flows` (state as a hash, the
  verifier, endpoints, client, resource; 10 minutes, at most 5 per server, deleted when read), in plaintext because the
  api, which holds only the public key, must read it back; it holds no token. The console's callback page
  (`/dashboard/tools/oauth/callback`, signed in) posts `POST /v1/tool-servers/oauth/callback { state, iss?, code |
  error }`; the api finds the flow in the caller's own tenant database (a code cannot land in another tenant), applies
  RFC 9207's `iss` table before showing any authorization-server error, exchanges the code with `resource`, seals the
  tokens as JSON under `tool-credential/<serverId>`, and queues a sync. Changing the auth kind, or the URL of an `oauth`
  server, drops the credential (tokens are bound to the old address) and any pending flow. The worker sends `Bearer
  <accessToken>` only to URLs within the credential's `resource`, refreshes when it expires within 60 s or once after a
  401, under `select ... for update` on the secret row (another worker's fresh token is used as is; rotated refresh tokens
  are stored), sealing with the public half of its own key. `invalid_grant` or no refresh token deletes the credential: the
  console shows "not connected" and the model or `last_error` says to connect it again. A credential belongs to the
  tenant, not to an end user.
- **The MCP client sits behind one package**, `packages/mcp`, written on the `fetch` it is given (the egress guard's): no
  dependency, since Kerby needs only `tools/list` and `tools/call` over Streamable HTTP and `@modelcontextprotocol/sdk`
  1.32.2 speaks at most 2025-11-25. A session's first request is 2026-07-28 (`_meta` and `MCP-Protocol-Version` on every
  request, no handshake). An unsupported-version error naming an older revision, or a 400/404/405 that is not a 2026-07-28
  refusal, makes it fall back to the handshake (`initialize` for 2025-11-25, `Mcp-Session-Id`, DELETE on close); a
  refused request ran nothing, so a write is never repeated by the fallback. `tools/list` stops at 50 pages, one message
  at 4 Mi characters. `@kerby/mcp/testing` is a real MCP server for tests, in both revisions.
- **The development stack reaches a local MCP server.** `createEgressFetch({ allowedHosts })` lets named hosts through
  although they resolve to private addresses (a redirect away from one is checked as usual). The worker and the api take
  them from `EGRESS_ALLOWED_HOSTS` and refuse it unless `KERBY_ENVIRONMENT=development`; compose names
  `host.docker.internal` (and, on the api, `127.0.0.1`, where the browser opens a test authorization server's authorize
  endpoint). `make tools-e2e` proves the path on the real stack; the OAuth Connect flow was walked by hand in the console
  against `startOAuthFixture` on the host.
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
- The egress guard refuses the Compose network, so the development stack names the one host it lets through
  (`host.docker.internal`, development only) and `make tools-e2e` runs the MCP test fixture on the host.
- One credential per server for the whole tenant: end users who each need their own account are not served yet.
