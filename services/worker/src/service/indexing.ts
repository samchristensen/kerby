// The chat search index (ADR 0019): built after turns on the `index` queue, queried on the `search` queue. Both need the
// tenant's model key for the embedding provider, which only a worker can open (ADR 0008). Indexing is derived data: it
// may lag a turn, it never holds a database connection while a provider answers, and a duplicate or concurrent task does
// no harm (`writeChunks` advances a conversation's watermark only from where the task read it).
import { parseModelId } from "@kerby/contracts";
import { recordUsage } from "@kerby/control-plane";
import { readMessages } from "@kerby/conversations";
import type { TenantContext } from "@kerby/db";
import { type RunContext, spawnInTx, type TaskParams } from "@kerby/durable";
import type { EmbeddingOutcome } from "@kerby/embeddings";
import { errorFields, log } from "@kerby/observability";
import {
  chunksToEmbed,
  chunkText,
  conversationIdsAfter,
  indexableText,
  indexedSeq,
  type MessageChunks,
  readSearchSettings,
  type SearchHitRef,
  searchChunks,
  setIndexError,
  writeChunks,
  writeEmbeddings,
} from "@kerby/search";
import type { WorkerDeps } from "../types/index.ts";

/** Messages read (bodies from S3) and chunked per transaction. */
const MESSAGES_PER_BATCH = 100;
/** Chunks sent to the provider per call: well under every supported provider's batch limit. */
const CHUNKS_PER_EMBEDDING = 32;
/** Conversations one `index-backfill` task indexes before it spawns the next page, so fresh turns' tasks interleave. */
const BACKFILL_PAGE = 50;

type Embed = (inputs: string[], signal: AbortSignal, usageKey: string) => Promise<EmbeddingOutcome>;
type Embedder = { type: "ready"; embed: Embed } | { type: "refused"; error: string };

/**
 * The tenant's embedding model, ready to call with its key, or why it cannot be: a malformed model id, a provider this
 * worker does not have, or no key. Those are refusals, not failures: the same task gets the same answer until the tenant
 * changes something. Usage is recorded once per `usageKey`.
 */
async function openEmbedder(deps: WorkerDeps, tenantId: string, model: string): Promise<Embedder> {
  const providerId = parseModelId(model)?.provider;
  if (!providerId)
    return {
      type: "refused",
      error: `embedding model "${model}" must look like <provider>/<modelId>`,
    };
  const provider = deps.embeddings.find((candidate) => candidate.id === providerId);
  if (!provider) {
    const known = deps.embeddings.map((candidate) => candidate.id).join(", ");
    return { type: "refused", error: `no embedding provider "${providerId}"; supported: ${known}` };
  }
  // Bring your own key. Only the development fake model runs without one (`modelKeys` is undefined there).
  let apiKey: string | undefined;
  if (deps.modelKeys) {
    apiKey = await deps.modelKeys(tenantId, providerId);
    if (!apiKey)
      return {
        type: "refused",
        error: `no model key for provider "${providerId}": PUT /v1/model-keys/${providerId}`,
      };
  }
  /** A provider's error can quote the key it rejected; nothing that leaves this function may. */
  const scrub = (text: string): string => (apiKey ? text.replaceAll(apiKey, "[redacted]") : text);
  const embed: Embed = async (inputs, signal, usageKey) => {
    let outcome: EmbeddingOutcome;
    try {
      outcome = await provider.embed({
        model,
        inputs,
        ...(apiKey === undefined ? {} : { apiKey }),
        signal,
      });
    } catch (caught) {
      if (apiKey && caught instanceof Error && caught.message.includes(apiKey))
        throw new Error(scrub(caught.message));
      throw caught;
    }
    if (outcome.type === "refused") return { type: "refused", error: scrub(outcome.error) };
    await recordUsage(deps.control, {
      tenantId,
      dedupeKey: usageKey,
      model: outcome.model,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: 0,
    });
    return outcome;
  };
  return { type: "ready", embed };
}

/** Chunk every message past the conversation's watermark. Blocked messages and their refusals are never indexed. */
async function chunkNewMessages(
  deps: WorkerDeps,
  ctx: TenantContext,
  conversationId: string,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const from = await indexedSeq(ctx.db, conversationId);
    const page = await readMessages(ctx, deps.blobs, conversationId, {
      after: from,
      limit: MESSAGES_PER_BATCH,
    });
    const last = page.messages.at(-1);
    if (!last) return;
    const messages: MessageChunks[] = [];
    for (const stored of page.messages) {
      const role = stored.message.role;
      if (stored.blockedBy !== null || role === "tool") continue;
      const text = indexableText(stored.message);
      const chunks = text === undefined ? [] : chunkText(text);
      if (chunks.length > 0)
        messages.push({ seq: stored.seq, role, createdAt: stored.createdAt, chunks });
    }
    const advanced = await writeChunks(ctx.db, conversationId, {
      from,
      through: last.seq,
      messages,
    });
    // Not advanced: another task moved the watermark first and wrote these; carry on from where it is now.
    if (advanced && page.nextAfter === null) return;
  }
}

/**
 * Embed the conversation's chunks that `model` has not, a batch per provider call, each batch written as it returns.
 * Returns false when the provider refused (recorded as the tenant's `lastError`), so a caller with more conversations
 * can stop asking.
 */
async function embedChunks(
  deps: WorkerDeps,
  ctx: TenantContext,
  conversationId: string,
  model: string,
  signal: AbortSignal,
): Promise<boolean> {
  let embedder: Embedder | undefined;
  for (;;) {
    signal.throwIfAborted();
    const pending = await chunksToEmbed(ctx.db, conversationId, model, CHUNKS_PER_EMBEDDING);
    const first = pending[0];
    if (!first) break;
    // The key is opened only when there is something to embed: most tasks after a short turn have a chunk or two.
    embedder ??= await openEmbedder(deps, ctx.tenantId, model);
    const outcome =
      embedder.type === "refused"
        ? embedder
        : await embedder.embed(
            pending.map((chunk) => chunk.text),
            signal,
            `embed:${conversationId}:${first.seq}.${first.part}:${model}`,
          );
    if (outcome.type === "refused") {
      await setIndexError(ctx.db, model, outcome.error);
      log("warn", "chat index could not embed", { conversationId });
      return false;
    }
    await writeEmbeddings(
      ctx.db,
      conversationId,
      model,
      pending.map((chunk, i) => {
        const vector = outcome.vectors[i];
        if (!vector) throw new Error(`the embedding provider returned no vector for input ${i}`);
        return { seq: chunk.seq, part: chunk.part, vector };
      }),
    );
  }
  if (embedder?.type === "ready") await setIndexError(ctx.db, model, null);
  return true;
}

/**
 * Bring one conversation's index up to date: chunk new messages, then embed with the tenant's model if it has one and
 * `embed` allows. Returns whether embedding went through (false after a refusal).
 */
async function indexConversation(
  deps: WorkerDeps,
  ctx: TenantContext,
  conversationId: string,
  signal: AbortSignal,
  embed = true,
): Promise<boolean> {
  await chunkNewMessages(deps, ctx, conversationId, signal);
  const { embeddingModel } = await readSearchSettings(ctx.db);
  if (!embeddingModel || !embed) return embed;
  return embedChunks(deps, ctx, conversationId, embeddingModel, signal);
}

/** Spawn an index task in the tenant's database and tell the workers. Idempotent per key. */
async function spawnIndexTask<N extends "index-conversation" | "index-backfill">(
  deps: WorkerDeps,
  ctx: TenantContext,
  name: N,
  params: TaskParams[N],
  idempotencyKey: string,
): Promise<void> {
  await ctx.db.transaction((tx) => spawnInTx(tx, name, params, { idempotencyKey }));
  // At-least-once: the worker's periodic sweep finds the task even if this notification is lost.
  await deps.control
    .query("select pg_notify('tenant_work', $1)", [ctx.tenantId])
    .catch((error: unknown) => {
      log(
        "warn",
        "could not notify workers; the sweep will find the index task",
        errorFields(error),
      );
    });
}

/**
 * After a turn: index the conversation through `lastSeq`. Best effort, since the turn is done and the next turn's task
 * (or a backfill) covers anything this one misses: a failure here is logged and never fails the turn.
 */
export async function enqueueIndexing(
  deps: WorkerDeps,
  ctx: TenantContext,
  conversationId: string,
  lastSeq: number,
): Promise<void> {
  try {
    await spawnIndexTask(
      deps,
      ctx,
      "index-conversation",
      { conversationId },
      `index:${conversationId}:${lastSeq}`,
    );
  } catch (error) {
    log("warn", "could not enqueue indexing after a turn", {
      conversationId,
      ...errorFields(error),
    });
  }
}

/** The `index-conversation` task body. */
export async function runIndexConversation(
  deps: WorkerDeps,
  ctx: TenantContext,
  params: TaskParams["index-conversation"],
  run: RunContext,
): Promise<void> {
  const started = performance.now();
  await indexConversation(deps, ctx, params.conversationId, run.signal);
  log("info", "conversation indexed", {
    conversationId: params.conversationId,
    durationMs: Math.round(performance.now() - started),
    attempt: run.attempt,
  });
}

/**
 * The `index-backfill` task body: one page of conversations, then the next page as a task of its own. A newer
 * `generation` (the embedding model changed again) supersedes it; that backfill covers everything.
 */
export async function runIndexBackfill(
  deps: WorkerDeps,
  ctx: TenantContext,
  params: TaskParams["index-backfill"],
  run: RunContext,
): Promise<void> {
  const started = performance.now();
  const { generation } = await readSearchSettings(ctx.db);
  if (generation !== params.generation) {
    log("info", "chat index backfill superseded", {
      generation: params.generation,
      current: generation,
    });
    return;
  }
  const ids = await conversationIdsAfter(ctx.db, params.after, BACKFILL_PAGE);
  // After one refusal the rest of the page is chunked without asking the provider again: it would refuse them too.
  let embed = true;
  for (const id of ids) embed = await indexConversation(deps, ctx, id, run.signal, embed);
  const last = ids.at(-1);
  const more = ids.length === BACKFILL_PAGE && last !== undefined;
  if (more)
    await spawnIndexTask(
      deps,
      ctx,
      "index-backfill",
      { generation: params.generation, after: last },
      `backfill:${params.generation}:${last}`,
    );
  log("info", "chat index backfill page done", {
    generation: params.generation,
    conversations: ids.length,
    more,
    durationMs: Math.round(performance.now() - started),
  });
}

type SearchOutcome = { mode: "hybrid" | "keyword"; notice: string | null; hits: SearchHitRef[] };

/**
 * The `run-search` task body: embed the query with the tenant's model and rank by words and meaning. Anything that stops
 * the embedding (no key, a refusal, the provider failing) still answers, with keyword matches and a notice saying why:
 * a search is interactive and has one attempt. The result holds references only; the api reads their text.
 */
export async function runSearchTask(
  deps: WorkerDeps,
  ctx: TenantContext,
  params: TaskParams["run-search"],
  run: RunContext,
): Promise<SearchOutcome> {
  const started = performance.now();
  const query = { query: params.query, limit: params.limit, externalUserId: params.externalUserId };
  const keyword = async (notice: string | null): Promise<SearchOutcome> => ({
    mode: "keyword",
    notice,
    hits: await searchChunks(ctx.db, query),
  });
  const semantic = async (model: string): Promise<SearchOutcome> => {
    const embedder = await openEmbedder(deps, ctx.tenantId, model);
    if (embedder.type === "refused")
      return keyword(`semantic search is unavailable: ${embedder.error}`);
    let embedded: EmbeddingOutcome;
    try {
      embedded = await embedder.embed([params.query], run.signal, `search:${run.taskId}`);
    } catch (error) {
      log("warn", "search could not embed its query", errorFields(error));
      return keyword("semantic search is unavailable: the embedding provider did not answer");
    }
    const vector = embedded.type === "embedded" ? embedded.vectors[0] : undefined;
    if (embedded.type === "refused" || !vector)
      return keyword(
        `semantic search is unavailable: ${embedded.type === "refused" ? embedded.error : "the provider returned no vector"}`,
      );
    return {
      mode: "hybrid",
      notice: null,
      hits: await searchChunks(ctx.db, { ...query, embedding: { model, vector } }),
    };
  };
  const { embeddingModel } = await readSearchSettings(ctx.db);
  const outcome = embeddingModel ? await semantic(embeddingModel) : await keyword(null);
  log("info", "search completed", {
    mode: outcome.mode,
    hits: outcome.hits.length,
    durationMs: Math.round(performance.now() - started),
  });
  return outcome;
}
