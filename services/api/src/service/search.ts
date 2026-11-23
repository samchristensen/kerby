// Chat search over HTTP (ADR 0021). Keyword search runs here; a semantic one needs the query embedded with the tenant's
// key, which only a worker can open (ADR 0008), so the api spawns `run-search`, waits briefly for its hit references
// and reads the snippets itself. Whatever goes wrong on the worker's side, the tenant still gets keyword results and a
// notice saying why. The query is never logged.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  MAX_SEARCH_HITS,
  parseModelId,
  type SearchHit,
  type SearchRequest,
  type SearchResponse,
  type SearchSettings,
  type Visibility,
} from "@kerby/contracts";
import { audit, hasModelKey, hintTenantWork } from "@kerby/control-plane";
import type { TenantContext, TenantQueryable } from "@kerby/db";
import { readTask, spawnInTx } from "@kerby/durable";
import { errorFields, log } from "@kerby/observability";
import {
  indexCounts,
  readHits,
  readSearchSettings,
  type SearchHitRecord,
  type SearchHitRef,
  searchChunks,
  setEmbeddingModel,
} from "@kerby/search";
import { z } from "zod";
import type { ApiDeps, Principal } from "../types/index.ts";
import { InvalidModelError } from "./models.ts";

/** A worker's answer to `run-search`: written by Kerby's own handler, still checked before its references are read. */
const SearchTaskResultSchema = z.object({
  mode: z.enum(["hybrid", "keyword"]),
  notice: z.string().nullable(),
  hits: z
    .array(
      z.object({
        conversationId: z.uuid(),
        seq: z.number().int().positive(),
        part: z.number().int().nonnegative(),
        score: z.number(),
      }),
    )
    .max(MAX_SEARCH_HITS),
});

/** First and longest pause between looks at the search task: a worker answers in tens of milliseconds plus the provider's time. */
const FIRST_POLL_MS = 25;
const MAX_POLL_MS = 200;

/** Search the chats `visibility` sees: keyword results here, or a semantic search through a worker (module comment). */
export async function searchChats(
  deps: ApiDeps,
  ctx: TenantContext,
  visibility: Visibility,
  body: SearchRequest,
  signal: AbortSignal,
): Promise<SearchResponse> {
  const settings = await readSearchSettings(ctx.db);
  if (settings.embeddingModel === null) return keywordSearch(ctx.db, visibility, body, null);

  const externalUserId = body.externalUserId ?? null;
  // One attempt: a retry would answer a request that has long since fallen back to keywords.
  const { taskId } = await ctx.db.transaction((tx) =>
    spawnInTx(
      tx,
      "run-search",
      { query: body.query, limit: body.limit, externalUserId, visibility },
      { idempotencyKey: `search:${randomUUID()}`, maxAttempts: 1, retry: { kind: "none" } },
    ),
  );
  await hintWorkers(deps, ctx.tenantId);

  const deadline = Date.now() + deps.settings.searchWaitMs;
  let pause = FIRST_POLL_MS;
  while (!signal.aborted) {
    const task = await readTask(ctx.db, "run-search", taskId);
    if (task?.state === "completed") {
      const result = SearchTaskResultSchema.safeParse(task.result);
      if (!result.success) {
        log("error", "a search task completed with a malformed result", { taskId });
        break;
      }
      const hits = await readHits(
        ctx.db,
        body.query,
        result.data.hits.slice(0, body.limit),
        visibility,
      );
      return { hits: hits.map(toHit), mode: result.data.mode, notice: result.data.notice };
    }
    if (task === undefined || task.state === "failed" || task.state === "cancelled")
      return keywordSearch(
        ctx.db,
        visibility,
        body,
        "semantic search failed; showing keyword matches. Try again, or check the embedding model in search settings",
      );
    const left = deadline - Date.now();
    if (left <= 0)
      return keywordSearch(
        ctx.db,
        visibility,
        body,
        "semantic search timed out; showing keyword matches",
      );
    await sleep(Math.min(pause, left));
    pause = Math.min(pause * 2, MAX_POLL_MS);
  }
  // The client went away, or the worker's answer was unusable: keywords are still an answer.
  return keywordSearch(ctx.db, visibility, body, "semantic search failed; showing keyword matches");
}

async function keywordSearch(
  db: TenantQueryable,
  visibility: Visibility,
  body: SearchRequest,
  notice: string | null,
): Promise<SearchResponse> {
  const refs: SearchHitRef[] = await searchChunks(
    db,
    { query: body.query, limit: body.limit, externalUserId: body.externalUserId ?? null },
    visibility,
  );
  const hits = await readHits(db, body.query, refs, visibility);
  return { hits: hits.map(toHit), mode: "keyword", notice };
}

const toHit = (record: SearchHitRecord): SearchHit => ({
  conversationId: record.conversationId,
  seq: record.seq,
  role: record.role,
  title: record.title,
  snippet: record.snippet,
  score: record.score,
  createdAt: record.createdAt.toISOString(),
});

export async function getSearchSettings(ctx: TenantContext): Promise<SearchSettings> {
  const settings = await readSearchSettings(ctx.db);
  const counts = await indexCounts(ctx.db, settings.embeddingModel);
  return {
    embeddingModel: settings.embeddingModel,
    lastError: settings.lastError,
    chunks: counts.chunks,
    embedded: counts.embedded,
    updatedAt: settings.updatedAt?.toISOString() ?? null,
  };
}

/**
 * Choose the tenant's embedding model, or none. A new model bumps the index's generation and starts a backfill that
 * embeds every indexed chat with it; the same model again changes nothing. Audited: choosing a model sends the
 * tenant's chats to its provider (ADR 0021).
 */
export async function putSearchSettings(
  deps: ApiDeps,
  principal: Principal,
  ctx: TenantContext,
  embeddingModel: string | null,
): Promise<SearchSettings> {
  if (embeddingModel !== null) await assertEmbeddingModel(deps, ctx.tenantId, embeddingModel);
  const { changed, spawned } = await ctx.db.transaction(async (tx) => {
    const { settings, changed } = await setEmbeddingModel(tx, embeddingModel);
    if (!changed || embeddingModel === null) return { changed, spawned: false };
    await spawnInTx(
      tx,
      "index-backfill",
      { generation: settings.generation, after: null },
      { idempotencyKey: `backfill:${settings.generation}:start` },
    );
    return { changed, spawned: true };
  });
  if (spawned) await hintWorkers(deps, ctx.tenantId);
  if (changed)
    await audit(deps.control, {
      tenantId: principal.tenantId,
      actor: principal.actor,
      action: "search.settings.put",
      // A model id names a product, not a secret.
      detail: { embeddingModel },
    });
  return getSearchSettings(ctx);
}

/** `model` must name an embedding provider the tenant holds a key for (or the keyless development fake). */
async function assertEmbeddingModel(deps: ApiDeps, tenantId: string, model: string): Promise<void> {
  const parsed = parseModelId(model);
  if (!parsed)
    throw new InvalidModelError(
      `embedding model "${model}" must look like <provider>/<modelId>, e.g. openai/text-embedding-3-small`,
    );
  const keyless = deps.settings.keylessProviders.includes(parsed.provider);
  if (!keyless && !deps.settings.embeddingProviders.includes(parsed.provider))
    throw new InvalidModelError(
      `"${parsed.provider}" is not an embedding provider; supported: ${deps.settings.embeddingProviders.join(", ")}`,
    );
  if (!keyless && !(await hasModelKey(deps.control, tenantId, parsed.provider)))
    throw new InvalidModelError(
      `no model key for provider "${parsed.provider}": PUT /v1/model-keys/${parsed.provider} first`,
    );
}

/** Mark the tenant due and ring the workers; the full sweep finds the task if the hint is lost. */
async function hintWorkers(deps: ApiDeps, tenantId: string): Promise<void> {
  await hintTenantWork(deps.control, tenantId).catch((error: unknown) => {
    log("warn", "could not hint workers; the full sweep will find the task", errorFields(error));
  });
}
