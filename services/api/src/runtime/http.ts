// The tenant-facing API. Every route but /healthz authenticates a bearer credential (an API key, or the console's session
// token for a signed-in person), runs as that credential's tenant, and declares the scope it needs (ADR 0020).
import {
  CreateConversationRequestSchema,
  CreatePromptRequestSchema,
  CreateSubscriptionRequestSchema,
  expandEventTypes,
  GetConversationQuerySchema,
  GetTraceQuerySchema,
  ListConversationsQuerySchema,
  ListDeliveriesQuerySchema,
  ListEventsQuerySchema,
  type ListEventsResponse,
  ListPromptsQuerySchema,
  ModelProviderSchema,
  PostMessageRequestSchema,
  PromptLabelSchema,
  PromptNameSchema,
  PromptVersionParamSchema,
  PublishPromptRequestSchema,
  PutModelKeyRequestSchema,
  RedeliverRequestSchema,
  RenamePromptRequestSchema,
  RenderPromptRequestSchema,
  SaveDraftRequestSchema,
  type Scope,
  SetPromptLabelRequestSchema,
  STREAM_INCLUDES,
  StreamIncludeSchema,
  SubmitJudgmentRequestSchema,
  UpdateSubscriptionRequestSchema,
} from "@kerby/contracts";
import { ModelKeyLimitError, SubscriptionLimitError } from "@kerby/control-plane";
import {
  ConversationBusyError,
  ConversationFullError,
  findConversation,
  InvalidCursorError,
} from "@kerby/conversations";
import { isUuid, type TenantContext, type TenantLease } from "@kerby/db";
import { pollEvents } from "@kerby/events";
import { log, withTenant } from "@kerby/observability";
import {
  DraftConflictError,
  InvalidVariablesError,
  NotPublishableError,
  PromptKindError,
  PromptLimitError,
  PromptNameTakenError,
  PromptNotFoundError,
  PromptPublishedError,
  PromptUnchangedError,
  ReservedLabelError,
  StorageQuotaExceededError,
} from "@kerby/prompts";
import {
  bearerToken,
  clientAddress,
  createRouter,
  type FetchHandler,
  HttpError,
  json,
  type Route,
  readJson,
  TokenBuckets,
  TurnsPerKey,
} from "@kerby/serve";
import { z } from "zod";
import { createAuthenticator } from "../service/auth.ts";
import {
  conversationEvents,
  createConversation,
  getConversation,
  getTrace,
  listTenantConversations,
  postMessage,
  type StreamItem,
} from "../service/conversations.ts";
import { getJudgment, submitJudgment } from "../service/judgments.ts";
import { listTenantModelKeys, removeModelKey, setModelKey } from "../service/model-keys.ts";
import { InvalidModelError } from "../service/models.ts";
import {
  createTenantPrompt,
  deleteTenantPrompt,
  getTenantPrompt,
  getTenantPromptVersion,
  listTenantPrompts,
  publishTenantPrompt,
  removeTenantPromptLabel,
  renameTenantPrompt,
  renderChatPrompt,
  saveTenantDraft,
  setTenantPromptLabel,
} from "../service/prompts.ts";
import {
  createTenantSubscription,
  deleteTenantSubscription,
  getTenantSubscription,
  IntegrationRequiredError,
  InvalidDestinationError,
  listTenantDeliveries,
  listTenantSubscriptions,
  pingTenantSubscription,
  redeliverToTenantSubscription,
  rotateTenantSubscriptionSecret,
  TenantScopeRequiredError,
  updateTenantSubscription,
} from "../service/subscriptions.ts";
import {
  type ApiDeps,
  LookupRefusedError,
  NotFoundError,
  type Principal,
  TenantUnavailableError,
  UnauthorizedError,
} from "../types/index.ts";

/** Body limit for posting a message: the schema allows 1 million characters of text, up to 4 bytes each. */
const MESSAGE_BODY_BYTES = 4_100_000;

/** Body limit for a judgment: its request is stored as the task's params, so it stays small (ADR 0015). */
const JUDGMENT_BODY_BYTES = 262_144;

const encoder = new TextEncoder();

function sse(items: AsyncGenerator<StreamItem>, release: () => Promise<void>): Response {
  const iterator = items[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Lets proxies and clients see the stream open before the first event.
      controller.enqueue(encoder.encode(": open\n\n"));
    },
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) {
          controller.close();
          await release();
          return;
        }
        if ("keepAlive" in value) controller.enqueue(encoder.encode(": keep-alive\n\n"));
        else {
          const id = value.id === undefined ? "" : `id: ${value.id}\n`;
          controller.enqueue(
            encoder.encode(
              `${id}event: ${value.envelope.event.type}\ndata: ${JSON.stringify(value.envelope)}\n\n`,
            ),
          );
        }
      } catch (error) {
        controller.error(error);
        await release();
      }
    },
    async cancel() {
      await iterator.return?.(undefined);
      await release();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}

/** 429 with `Retry-After`: the client may try again in `seconds`. */
const rateLimited = (seconds: number, message: string): Response =>
  json(
    429,
    { error: { code: "rate_limited", message: `${message}; retry in ${seconds} s` } },
    { "retry-after": String(seconds) },
  );

/** Keys each limiter remembers: tenants, and client addresses that failed to authenticate. */
const MAX_LIMITER_KEYS = 100_000;
/**
 * Key lookups one client address runs at once; the rest wait their turn. A concurrent burst of bad keys therefore gets at
 * most `FAILED_AUTH_PER_MINUTE + LOOKUPS_PER_ADDRESS - 1` lookups, and many good keys at once only wait a moment.
 */
export const LOOKUPS_PER_ADDRESS = 4;

export function createApiApp(deps: ApiDeps): FetchHandler {
  const auth = createAuthenticator(deps.control, deps.settings.authCacheMs);
  const requests = new TokenBuckets({ maxKeys: MAX_LIMITER_KEYS });
  const failedAuth = new TokenBuckets({ maxKeys: MAX_LIMITER_KEYS });
  const lookups = new TurnsPerKey(LOOKUPS_PER_ADDRESS);

  /**
   * Authenticate, check the credential holds `scope`, then run `handler` with the tenant's context. The tenant id comes
   * from the key only. Every route names its scope, so none can forget one.
   */
  const authed =
    (
      route: string,
      scope: Scope,
      handler: (
        request: Request,
        params: Record<string, string>,
        principal: Principal,
      ) => Promise<Response> | Response,
    ): Route[2] =>
    async (request, params, client) => {
      // The only work done before a key is verified is a key lookup: an address that keeps presenting bad keys is
      // refused without one, whatever key it sends next.
      const address = clientAddress(
        request.headers.get("x-forwarded-for"),
        client.address,
        deps.settings.trustProxy,
      );
      const perMinute = deps.settings.failedAuthPerMinute;
      const blocked = failedAuth.wait(address, perMinute);
      if (blocked > 0) return rateLimited(blocked, "too many failed authentications");
      const presented = bearerToken(request);
      if (!presented) {
        failedAuth.take(address, perMinute);
        throw new HttpError(
          401,
          "unauthorized",
          "an API key is required: Authorization: Bearer <key>",
        );
      }
      let principal: Principal;
      try {
        // A lookup waits its turn among the address's lookups, checks the limit when its turn comes and counts a wrong
        // key before giving its turn up, so a concurrent burst cannot all pass the check above. A credential the cache
        // answers, or that another request is already looking up, costs no lookup.
        principal = await auth.authenticate(presented, (lookup) =>
          lookups.run(address, async () => {
            const wait = failedAuth.wait(address, perMinute);
            if (wait > 0) throw new LookupRefusedError(wait);
            const found = await lookup();
            if (!found) failedAuth.take(address, perMinute);
            return found;
          }),
        );
      } catch (error) {
        if (error instanceof LookupRefusedError)
          return rateLimited(error.retryAfterSeconds, "too many failed authentications");
        if (error instanceof UnauthorizedError)
          throw new HttpError(401, "unauthorized", "invalid API key");
        if (error instanceof TenantUnavailableError)
          throw new HttpError(403, "tenant_unavailable", error.message);
        throw error;
      }
      // One line per authenticated request, tagged with the tenant: the route pattern, never the path or body.
      const started = performance.now();
      let status = 500;
      try {
        return await withTenant(principal.tenantId, async () => {
          try {
            if (!principal.scopes.has(scope))
              throw new HttpError(
                403,
                "forbidden",
                `this key's integration lacks the "${scope}" scope; an integration's scopes are set in the console`,
              );
            const rate =
              principal.limits.requestsPerMinute ?? deps.settings.defaultRequestsPerMinute;
            const wait = requests.take(principal.tenantId, rate);
            const response =
              wait > 0
                ? rateLimited(wait, `at most ${rate} requests per minute`)
                : await handler(request, params, principal);
            status = response.status;
            return response;
          } catch (error) {
            if (error instanceof NotFoundError || error instanceof PromptNotFoundError)
              throw new HttpError(404, "not_found", error.message);
            if (error instanceof ConversationFullError)
              throw new HttpError(413, "conversation_full", error.message);
            if (error instanceof StorageQuotaExceededError)
              throw new HttpError(413, "storage_quota_exceeded", error.message);
            if (error instanceof ConversationBusyError)
              throw new HttpError(409, "conversation_busy", error.message);
            if (error instanceof InvalidCursorError || error instanceof ReservedLabelError)
              throw new HttpError(400, "invalid_request", error.message);
            if (error instanceof ModelKeyLimitError)
              throw new HttpError(409, "model_key_limit", error.message);
            if (error instanceof SubscriptionLimitError)
              throw new HttpError(409, "subscription_limit", error.message);
            if (error instanceof InvalidDestinationError)
              throw new HttpError(400, "invalid_destination", error.message);
            if (error instanceof IntegrationRequiredError)
              throw new HttpError(400, "invalid_request", error.message);
            if (error instanceof TenantScopeRequiredError)
              throw new HttpError(403, "forbidden", error.message);
            if (error instanceof InvalidModelError)
              throw new HttpError(400, "invalid_model", error.message);
            if (error instanceof PromptNameTakenError)
              throw new HttpError(409, "name_taken", error.message);
            if (error instanceof PromptLimitError)
              throw new HttpError(409, "prompt_limit", error.message);
            if (error instanceof PromptPublishedError)
              throw new HttpError(409, "prompt_published", error.message);
            if (error instanceof DraftConflictError)
              throw new HttpError(409, "draft_conflict", error.message);
            if (error instanceof PromptUnchangedError)
              throw new HttpError(409, "unchanged", error.message);
            if (error instanceof PromptKindError)
              throw new HttpError(400, "wrong_kind", error.message);
            if (error instanceof NotPublishableError)
              throw new HttpError(400, "not_publishable", error.message);
            if (error instanceof InvalidVariablesError)
              throw new HttpError(400, "invalid_variables", error.message);
            throw error;
          }
        });
      } catch (error) {
        status = error instanceof HttpError ? error.status : 500;
        throw error;
      } finally {
        withTenant(principal.tenantId, () =>
          log("info", "request", {
            route,
            method: request.method,
            status,
            durationMs: Math.round(performance.now() - started),
          }),
        );
      }
    };

  /** Run `fn` with the tenant's database for the duration of one call. */
  const inTenant = <T>(principal: Principal, fn: (ctx: TenantContext) => Promise<T>): Promise<T> =>
    deps.pools.use(principal.tenantId, (db) => fn({ tenantId: principal.tenantId, db }));

  const conversationId = (params: Record<string, string>): string => {
    const id = params.id ?? "";
    if (!isUuid(id)) throw new HttpError(404, "not_found", "conversation not found");
    return id;
  };

  /**
   * Requests that hold their tenant's pool while they wait (event streams, long polls of `GET /v1/events`), in this
   * process in all and per tenant: each leases its tenant's pool and shares the tenant's listening connection for as
   * long as it lives (connection budget: docs/deploy.md#postgres).
   */
  let streamsOpen = 0;
  const openStreams = new Map<string, number>();

  /** Count one more held request of the tenant, or refuse it: 503 past the process cap, 429 past the tenant's. Returns its release. */
  const admitStream = (tenantId: string, instead: string): (() => void) => {
    if (streamsOpen >= deps.settings.maxStreamsPerProcess)
      throw new HttpError(
        503,
        "server_busy",
        `this server holds its maximum of ${deps.settings.maxStreamsPerProcess} open event streams; retry shortly, or ${instead}`,
      );
    const open = openStreams.get(tenantId) ?? 0;
    if (open >= deps.settings.maxStreamsPerTenant)
      throw new HttpError(
        429,
        "too_many_streams",
        `at most ${deps.settings.maxStreamsPerTenant} event streams and long polls may be open at once`,
      );
    streamsOpen++;
    openStreams.set(tenantId, open + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      streamsOpen--;
      const left = (openStreams.get(tenantId) ?? 1) - 1;
      if (left > 0) openStreams.set(tenantId, left);
      else openStreams.delete(tenantId);
    };
  };

  const providerParam = (params: Record<string, string>): string => {
    const parsed = ModelProviderSchema.safeParse(params.provider);
    if (!parsed.success) throw new HttpError(404, "not_found", "model key not found");
    return parsed.data;
  };

  /** `:name` is one path segment, its `/` sent as `%2F`; a name that cannot exist is simply not found. */
  const promptName = (params: Record<string, string>): string => {
    const parsed = PromptNameSchema.safeParse(params.name);
    if (!parsed.success) throw new HttpError(404, "not_found", "no prompt by that name");
    return parsed.data;
  };

  const promptVersion = (params: Record<string, string>) => {
    const parsed = PromptVersionParamSchema.safeParse(params.version);
    if (!parsed.success)
      throw new HttpError(404, "not_found", "a version is a number from 1 or a label");
    return parsed.data;
  };

  const promptLabel = (params: Record<string, string>): string => {
    const parsed = PromptLabelSchema.safeParse(params.label);
    if (!parsed.success)
      throw new HttpError(
        400,
        "invalid_request",
        "a label is a lowercase letter, then lowercase letters, digits or -, up to 32",
      );
    return parsed.data;
  };

  const routes: Route[] = [
    ["GET", "/healthz", () => json(200, { ok: true })],
    [
      "GET",
      "/v1/model-keys",
      authed("GET /v1/model-keys", "admin", async (_request, _params, principal) =>
        json(200, await listTenantModelKeys(deps, principal)),
      ),
    ],
    [
      "PUT",
      "/v1/model-keys/:provider",
      authed("PUT /v1/model-keys/:provider", "admin", async (request, params, principal) => {
        // The adapters' lists (ADR 0008, 0015): a key for a provider nothing can use would fail only at the first call.
        const provider = params.provider ?? "";
        const providers = [
          ...new Set([...deps.settings.modelProviders, ...deps.settings.judgmentProviders]),
        ];
        if (!providers.includes(provider))
          throw new HttpError(
            400,
            "unknown_provider",
            `unknown model provider; supported: ${providers.join(", ")}`,
          );
        const body = await readJson(request, PutModelKeyRequestSchema, { maxBytes: 16_384 });
        await setModelKey(deps, principal, provider, body.apiKey);
        return new Response(null, { status: 204 });
      }),
    ],
    [
      "DELETE",
      "/v1/model-keys/:provider",
      authed("DELETE /v1/model-keys/:provider", "admin", async (_request, params, principal) => {
        if (!(await removeModelKey(deps, principal, providerParam(params))))
          throw new NotFoundError("model key not found");
        return new Response(null, { status: 204 });
      }),
    ],
    [
      "POST",
      "/v1/conversations",
      authed("POST /v1/conversations", "conversations", async (request, _params, principal) => {
        const body = await readJson(request, CreateConversationRequestSchema);
        return json(
          201,
          await inTenant(principal, (ctx) =>
            createConversation(deps, ctx, principal.integrationId, body),
          ),
        );
      }),
    ],
    [
      "GET",
      "/v1/conversations",
      authed("GET /v1/conversations", "conversations", async (request, _params, principal) => {
        const query = ListConversationsQuerySchema.safeParse(
          Object.fromEntries(new URL(request.url).searchParams),
        );
        if (!query.success)
          throw new HttpError(
            400,
            "invalid_request",
            "limit must be 1 to 100, cursor a previous nextCursor, externalUserId at most 128 characters",
          );
        return json(
          200,
          await inTenant(principal, (ctx) =>
            listTenantConversations(ctx, query.data, principal.visibility),
          ),
        );
      }),
    ],
    [
      "POST",
      "/v1/conversations/:id/messages",
      authed(
        "POST /v1/conversations/:id/messages",
        "conversations",
        async (request, params, principal) => {
          const id = conversationId(params);
          const body = await readJson(request, PostMessageRequestSchema, {
            maxBytes: MESSAGE_BODY_BYTES,
          });
          const storageBytes = principal.limits.storageBytes ?? deps.settings.defaultStorageBytes;
          return json(
            202,
            await inTenant(principal, (ctx) =>
              postMessage(deps, ctx, principal.visibility, id, body, storageBytes),
            ),
          );
        },
      ),
    ],
    [
      "GET",
      "/v1/conversations/:id",
      authed("GET /v1/conversations/:id", "conversations", async (request, params, principal) => {
        const id = conversationId(params);
        const query = GetConversationQuerySchema.safeParse(
          Object.fromEntries(new URL(request.url).searchParams),
        );
        if (!query.success)
          throw new HttpError(
            400,
            "invalid_request",
            "after must be a sequence number (0 or more) and limit 1 to 500",
          );
        const page = query.data;
        return json(
          200,
          await inTenant(principal, (ctx) =>
            getConversation(deps, ctx, principal.visibility, id, page),
          ),
        );
      }),
    ],
    [
      "GET",
      "/v1/conversations/:id/events",
      authed(
        "GET /v1/conversations/:id/events",
        "conversations",
        async (request, params, principal) => {
          const id = conversationId(params);
          const header =
            request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after");
          const after = header === null ? 0 : Number(header);
          if (!Number.isInteger(after) || after < 0)
            throw new HttpError(400, "invalid_request", "Last-Event-ID must be a sequence number");
          const include = StreamIncludeSchema.safeParse(
            new URL(request.url).searchParams.get("include") ?? undefined,
          );
          if (!include.success)
            throw new HttpError(
              400,
              "invalid_request",
              `include is a comma-separated list of: ${STREAM_INCLUDES.join(", ")}`,
            );
          const releaseSlot = admitStream(
            principal.tenantId,
            "read the conversation with GET /v1/conversations/:id",
          );
          let released = false;
          let lease: TenantLease | undefined;
          const release = async () => {
            if (released) return;
            released = true;
            releaseSlot();
            await lease?.release();
          };
          const presented = bearerToken(request) ?? "";
          // A stream outlives the check that opened it: look again, so revoking a key or suspending a tenant ends it
          // within the same window as for a request.
          const stillAllowed = () =>
            auth.authenticate(presented).then(
              () => true,
              () => false,
            );
          try {
            // The pool stays leased for as long as the stream is open.
            lease = await deps.pools.acquire(principal.tenantId);
            // Look the conversation up before sending headers, so a wrong id is a 404 and not an empty stream.
            if (!(await findConversation(lease.db, id, principal.visibility)))
              throw new NotFoundError("conversation not found");
            const events = conversationEvents(
              deps,
              { tenantId: principal.tenantId, db: lease.db },
              principal.visibility,
              id,
              after,
              include.data,
              request.signal,
              stillAllowed,
            );
            return sse(events, release);
          } catch (error) {
            await release();
            throw error;
          }
        },
      ),
    ],
    [
      "GET",
      "/v1/conversations/:id/trace",
      authed(
        "GET /v1/conversations/:id/trace",
        "conversations",
        async (request, params, principal) => {
          const id = conversationId(params);
          const query = GetTraceQuerySchema.safeParse(
            Object.fromEntries(new URL(request.url).searchParams),
          );
          if (!query.success)
            throw new HttpError(
              400,
              "invalid_request",
              "after must be a cursor (0 or more) and limit 1 to 1000",
            );
          return json(
            200,
            await inTenant(principal, (ctx) =>
              getTrace(deps, ctx, principal.visibility, id, query.data),
            ),
          );
        },
      ),
    ],
    [
      "POST",
      "/v1/judgments",
      authed("POST /v1/judgments", "judgments", async (request, _params, principal) => {
        const body = await readJson(request, SubmitJudgmentRequestSchema, {
          maxBytes: JUDGMENT_BODY_BYTES,
        });
        return json(
          202,
          await inTenant(principal, (ctx) =>
            submitJudgment(deps, ctx, principal.integrationId, body),
          ),
        );
      }),
    ],
    [
      "GET",
      "/v1/judgments/:id",
      authed("GET /v1/judgments/:id", "judgments", async (_request, params, principal) => {
        const id = z.uuid().safeParse(params.id);
        if (!id.success) throw new HttpError(404, "not_found", "judgment not found");
        return json(
          200,
          await inTenant(principal, (ctx) => getJudgment(ctx, principal.visibility, id.data)),
        );
      }),
    ],
    [
      "GET",
      "/v1/events",
      authed("GET /v1/events", "events", async (request, _params, principal) => {
        const query = ListEventsQuerySchema.safeParse(
          Object.fromEntries(new URL(request.url).searchParams),
        );
        if (!query.success) {
          const issue = query.error.issues[0];
          throw new HttpError(
            400,
            "invalid_request",
            `${String(issue?.path[0] ?? "query")}: ${issue?.message ?? "invalid"}`,
          );
        }
        const { after, limit, types, conversationId, wait } = query.data;
        const filter = {
          visibility: principal.visibility,
          types: types && expandEventTypes(types),
          conversationId,
        };
        // A long poll holds its tenant's pool and a listening connection as a stream does, so it counts as one.
        const release =
          wait === 0 ? () => {} : admitStream(principal.tenantId, "poll without wait");
        try {
          const page: ListEventsResponse = await inTenant(principal, (ctx) =>
            pollEvents(ctx.db, after, filter, limit, wait * 1000, request.signal),
          );
          return json(200, page);
        } finally {
          release();
        }
      }),
    ],
    [
      "GET",
      "/v1/prompts",
      authed("GET /v1/prompts", "admin", async (request, _params, principal) => {
        const query = ListPromptsQuerySchema.safeParse(
          Object.fromEntries(new URL(request.url).searchParams),
        );
        if (!query.success)
          throw new HttpError(400, "invalid_request", "kind must be chat or decision");
        return json(200, await inTenant(principal, (ctx) => listTenantPrompts(ctx, query.data)));
      }),
    ],
    [
      "POST",
      "/v1/prompts",
      authed("POST /v1/prompts", "admin", async (request, _params, principal) => {
        const body = await readJson(request, CreatePromptRequestSchema);
        return json(
          201,
          await inTenant(principal, (ctx) => createTenantPrompt(deps, principal, ctx, body)),
        );
      }),
    ],
    [
      "GET",
      "/v1/prompts/:name",
      authed("GET /v1/prompts/:name", "admin", async (_request, params, principal) => {
        const name = promptName(params);
        return json(200, await inTenant(principal, (ctx) => getTenantPrompt(ctx, name)));
      }),
    ],
    [
      "PATCH",
      "/v1/prompts/:name",
      authed("PATCH /v1/prompts/:name", "admin", async (request, params, principal) => {
        const name = promptName(params);
        const body = await readJson(request, RenamePromptRequestSchema);
        return json(
          200,
          await inTenant(principal, (ctx) =>
            renameTenantPrompt(deps, principal, ctx, name, body.name),
          ),
        );
      }),
    ],
    [
      "DELETE",
      "/v1/prompts/:name",
      authed("DELETE /v1/prompts/:name", "admin", async (_request, params, principal) => {
        const name = promptName(params);
        await inTenant(principal, (ctx) => deleteTenantPrompt(deps, principal, ctx, name));
        return new Response(null, { status: 204 });
      }),
    ],
    [
      "PUT",
      "/v1/prompts/:name/draft",
      authed("PUT /v1/prompts/:name/draft", "admin", async (request, params, principal) => {
        const name = promptName(params);
        const body = await readJson(request, SaveDraftRequestSchema);
        return json(
          200,
          await inTenant(principal, (ctx) => saveTenantDraft(deps, principal, ctx, name, body)),
        );
      }),
    ],
    [
      "POST",
      "/v1/prompts/:name/versions",
      authed("POST /v1/prompts/:name/versions", "admin", async (request, params, principal) => {
        const name = promptName(params);
        const body = await readJson(request, PublishPromptRequestSchema);
        return json(
          201,
          await inTenant(principal, (ctx) => publishTenantPrompt(deps, principal, ctx, name, body)),
        );
      }),
    ],
    [
      "GET",
      "/v1/prompts/:name/versions/:version",
      authed(
        "GET /v1/prompts/:name/versions/:version",
        "admin",
        async (_request, params, principal) => {
          const name = promptName(params);
          const version = promptVersion(params);
          return json(
            200,
            await inTenant(principal, (ctx) => getTenantPromptVersion(ctx, name, version)),
          );
        },
      ),
    ],
    [
      "POST",
      "/v1/prompts/:name/versions/:version/render",
      authed(
        "POST /v1/prompts/:name/versions/:version/render",
        "admin",
        async (request, params, principal) => {
          const name = promptName(params);
          const version = promptVersion(params);
          const body = await readJson(request, RenderPromptRequestSchema);
          return json(
            200,
            await inTenant(principal, (ctx) =>
              renderChatPrompt(ctx, { name, version, variables: body.variables }),
            ),
          );
        },
      ),
    ],
    [
      "PUT",
      "/v1/prompts/:name/labels/:label",
      authed("PUT /v1/prompts/:name/labels/:label", "admin", async (request, params, principal) => {
        const name = promptName(params);
        const label = promptLabel(params);
        const body = await readJson(request, SetPromptLabelRequestSchema);
        return json(
          200,
          await inTenant(principal, (ctx) =>
            setTenantPromptLabel(deps, principal, ctx, name, label, body.version),
          ),
        );
      }),
    ],
    [
      "DELETE",
      "/v1/prompts/:name/labels/:label",
      authed(
        "DELETE /v1/prompts/:name/labels/:label",
        "admin",
        async (_request, params, principal) => {
          const name = promptName(params);
          const label = promptLabel(params);
          await inTenant(principal, (ctx) =>
            removeTenantPromptLabel(deps, principal, ctx, name, label),
          );
          return new Response(null, { status: 204 });
        },
      ),
    ],
    [
      "POST",
      "/v1/subscriptions",
      authed("POST /v1/subscriptions", "admin", async (request, _params, principal) => {
        const body = await readJson(request, CreateSubscriptionRequestSchema, { maxBytes: 16_384 });
        return json(
          201,
          await inTenant(principal, (ctx) => createTenantSubscription(deps, principal, ctx, body)),
        );
      }),
    ],
    [
      "GET",
      "/v1/subscriptions",
      authed("GET /v1/subscriptions", "admin", async (_request, _params, principal) =>
        json(200, await listTenantSubscriptions(deps, principal)),
      ),
    ],
    [
      "GET",
      "/v1/subscriptions/:id",
      authed("GET /v1/subscriptions/:id", "admin", async (_request, params, principal) =>
        json(200, await getTenantSubscription(deps, principal, params.id ?? "")),
      ),
    ],
    [
      "PATCH",
      "/v1/subscriptions/:id",
      authed("PATCH /v1/subscriptions/:id", "admin", async (request, params, principal) => {
        const body = await readJson(request, UpdateSubscriptionRequestSchema, { maxBytes: 16_384 });
        return json(200, await updateTenantSubscription(deps, principal, params.id ?? "", body));
      }),
    ],
    [
      "DELETE",
      "/v1/subscriptions/:id",
      authed("DELETE /v1/subscriptions/:id", "admin", async (_request, params, principal) => {
        await deleteTenantSubscription(deps, principal, params.id ?? "");
        return new Response(null, { status: 204 });
      }),
    ],
    [
      "POST",
      "/v1/subscriptions/:id/secret",
      authed("POST /v1/subscriptions/:id/secret", "admin", async (_request, params, principal) =>
        json(200, await rotateTenantSubscriptionSecret(deps, principal, params.id ?? "")),
      ),
    ],
    [
      "POST",
      "/v1/subscriptions/:id/test",
      authed("POST /v1/subscriptions/:id/test", "admin", async (_request, params, principal) =>
        json(
          202,
          await inTenant(principal, (ctx) =>
            pingTenantSubscription(deps, principal, ctx, params.id ?? ""),
          ),
        ),
      ),
    ],
    [
      "POST",
      "/v1/subscriptions/:id/redeliver",
      authed(
        "POST /v1/subscriptions/:id/redeliver",
        "admin",
        async (request, params, principal) => {
          const body = await readJson(request, RedeliverRequestSchema, { maxBytes: 4096 });
          return json(
            202,
            await inTenant(principal, (ctx) =>
              redeliverToTenantSubscription(deps, principal, ctx, params.id ?? "", body.eventId),
            ),
          );
        },
      ),
    ],
    [
      "GET",
      "/v1/subscriptions/:id/deliveries",
      authed(
        "GET /v1/subscriptions/:id/deliveries",
        "admin",
        async (request, params, principal) => {
          const query = ListDeliveriesQuerySchema.safeParse(
            Object.fromEntries(new URL(request.url).searchParams),
          );
          if (!query.success)
            throw new HttpError(
              400,
              "invalid_request",
              "limit must be 1 to 100, before a previous nextBefore",
            );
          return json(
            200,
            await inTenant(principal, (ctx) =>
              listTenantDeliveries(deps, principal, ctx, params.id ?? "", query.data),
            ),
          );
        },
      ),
    ],
  ];
  return createRouter(routes);
}
