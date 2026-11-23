# 0021. Chat search: a per-tenant index of every conversation, built after each turn

- Status: proposed
- Date: 2026-11-23

## Context

A tenant wants to find past conversations ("the chat where we priced the Acme renewal") and, later, to give an agent a
tool over them (an MCP tool, then an agent that answers questions about past chats). Messages live in S3 with an index
row each; nothing could search their text. The work is derived data, so it may lag a turn, but it must never slow a
turn, hold a model key outside the worker (ADR 0008), or cross tenants.

## Decision

- **The index lives in the tenant's database** (`packages/search`, tenant migration `search/0001_search.sql`): a
  `search_chunks` row per piece of a message's text (`conversation_id`, `seq`, `part`, `role`, `text`, a generated
  English `tsvector`, a `halfvec` embedding and the model that made it), `search_progress` (how far each conversation
  is chunked) and one `search_settings` row (the embedding model, a `generation` bumped when it changes, the last
  indexing error). Tenancy is the database, as for every tenant table. Rows cascade with their message.
- **pgvector.** Railway's Postgres image (`postgres-ssl:18`) ships it; Compose and the test containers run
  `pgvector/pgvector` on Postgres 18 instead of `postgres:18-alpine`. `vector` is not a trusted extension, so a tenant
  role cannot create it: the template gets it from its superuser migration, and control installs it in every existing
  tenant database (`ClusterAdmin.ensureExtension`) before the migration fan-out. The tenant migration's
  `create extension if not exists` is then a no-op. `reassignOwned` leaves extension members with the admin.
- **What is indexed.** User and assistant text parts (not tool calls, tool results, reasoning or blobs), split into
  chunks of about 1200 characters with 200 of overlap at paragraph, sentence or word boundaries. A message a guardrail
  blocked, and its refusal, are never indexed: they are kept out of history for the same reason.
- **Built after the turn, on its own queue.** `run-turn` ends by spawning `index-conversation { conversationId }` on a
  new Absurd queue `index` (idempotency key `index:<conversation>:<last seq>`) and notifying `tenant_work`. The task
  chunks the messages past the conversation's watermark, then embeds the chunks whose `embedding_model` is not the
  current one. No connection is held during a provider call: a batch is written in one short transaction that advances
  the watermark only if it is still where the task read it, so a duplicate or concurrent task does no harm.
  `index-backfill { generation, after }` indexes 50 conversations by id and spawns the next page; it is spawned by the
  migration for a tenant that already has conversations (generation 0) and by every change of embedding model, and stops
  when a newer generation exists.
- **The worker runs three queues** (`packages/durable` claims per queue; the scheduler has a lane per queue): `turns`
  (the tenant's `maxConcurrentTurns`, `MAX_RUNNING_TURNS`), `index` (1 per tenant, `MAX_RUNNING_INDEX_TASKS` per worker,
  default 2) and `search` (4 per tenant, `MAX_RUNNING_SEARCHES`, default 4). A backfill never takes a turn's slot.
- **Embeddings are bring-your-own-key** (ADR 0008). `packages/embeddings` is the port (`EmbeddingProvider`, types only,
  plus a deterministic fake for development and tests); `packages/embeddings-openai` speaks the OpenAI `/v1/embeddings`
  wire format with `fetch` for the providers that serve it with the tenant's existing chat key: `openai`, `google`,
  `mistral`, `fireworks`, `openrouter` and `opencode` (each checked against its API reference; OpenCode's is the
  Console's `/inference/openai/v1/embeddings`, so its pay-as-you-go key, one key for chat, decisions and embeddings;
  `together` is left out, since its embeddings need a dedicated endpoint). A tenant chooses an embedding model
  (`PUT /v1/search/settings { embeddingModel: "openai/text-embedding-3-small" }`, audited); without one search is
  keyword only. A provider's refusal (bad key, unknown model) is stored as `search_settings.last_error` and
  not retried; an outage throws and the task retries.
- **Search is hybrid.** `POST /v1/search { query, limit, externalUserId? }` ranks Postgres full-text matches
  (`websearch_to_tsquery`) and cosine neighbours (`<=>` over chunks of the current model) and fuses the two lists by
  reciprocal rank; it returns the best chunk per conversation with a snippet. The api cannot open model keys, so with an
  embedding model set it spawns `run-search` on the `search` queue (one attempt), waits up to 10 s for its result (hit
  references, never text) and reads the snippets itself. Without a model, or when the worker reports or times out, the api
  answers with keyword results and says why (`mode`, `notice`). The query is a POST body so it stays out of URLs and logs.
- **Integrations (ADR 0020).** `POST /v1/search` needs the `conversations` scope and searches only what the key sees:
  without `tenant`, its own integration's conversations. `searchChunks` and `readHits` take a `Visibility`, and
  `run-search` carries the caller's, so neither the worker's ranking nor the api's snippets can forget the filter. The
  settings are the tenant's, beside its model keys: scope `admin`. The index itself is built for the whole tenant.
- **No ANN index yet.** Vectors of any dimension share the column, filtered by model; a search scans the tenant's
  chunks exactly. Trigger to add a per-model HNSW expression index: a tenant past 100 000 chunks or a search over 500 ms.

## Consequences

- Anthropic-only tenants get keyword search: Anthropic offers no embeddings endpoint. OpenCode's embedding models are a
  Console feature (its docs: not in Go or the free tier); whatever its endpoint refuses shows in `lastError`.
- Setting an embedding model sends every indexed chat's text to that provider with the tenant's key; the audit log
  records who chose it.
- Chunk text duplicates message text in the tenant's database; it is bounded by the conversation caps and not counted
  in `storageBytes`.
- A semantic search costs a worker round trip (notify, claim, key, provider) on top of the query: about 35 ms on the
  local stack with the fake embedder, plus the provider's own latency with a real one.
- Absurd keeps a search's query in the tenant's own database for its retention (30 days).
- Not built yet: the MCP tool over the index, and an agent that answers questions about past chats.
