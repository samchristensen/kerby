// The tenant-facing API. Every route but /healthz authenticates a bearer credential (an API key, or the console's session
// token for a signed-in person) and runs as that credential's tenant.
import {
  CreateConversationRequestSchema,
  GetConversationQuerySchema,
  ListConversationsQuerySchema,
  ModelProviderSchema,
  PostMessageRequestSchema,
  PutModelKeyRequestSchema,
} from "@kerby/contracts";
import { ModelKeyLimitError } from "@kerby/control-plane";
import {
  ConversationBusyError,
  ConversationFullError,
  findConversation,
  InvalidCursorError,
  isConversationId,
  StorageQuotaExceededError,
} from "@kerby/conversations";
import type { TenantContext, TenantLease } from "@kerby/db";
import { log, withTenant } from "@kerby/observability";
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
} from "@kerby/serve";
import { createAuthenticator } from "../service/auth.ts";
import {
  conversationEvents,
  createConversation,
  getConversation,
  InvalidModelError,
  listTenantConversations,
  postMessage,
  type StreamItem,
} from "../service/conversations.ts";
import { listTenantModelKeys, removeModelKey, setModelKey } from "../service/model-keys.ts";
import {
  type ApiDeps,
  NotFoundError,
  type Principal,
  TenantUnavailableError,
  UnauthorizedError,
} from "../types/index.ts";

/** Body limit for posting a message: the schema allows 1 million characters of text, up to 4 bytes each. */
const MESSAGE_BODY_BYTES = 4_100_000;

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

export function createApiApp(deps: ApiDeps): FetchHandler {
  const auth = createAuthenticator(deps.control, deps.settings.authCacheMs);
  const requests = new TokenBuckets({ maxKeys: MAX_LIMITER_KEYS });
  const failedAuth = new TokenBuckets({ maxKeys: MAX_LIMITER_KEYS });

  /** Authenticate, then run `handler` with the tenant's context. The tenant id comes from the key only. */
  const authed =
    (
      route: string,
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
        principal = await auth.authenticate(presented);
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          failedAuth.take(address, perMinute);
          throw new HttpError(401, "unauthorized", "invalid API key");
        }
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
            if (error instanceof NotFoundError)
              throw new HttpError(404, "not_found", error.message);
            if (error instanceof ConversationFullError)
              throw new HttpError(413, "conversation_full", error.message);
            if (error instanceof StorageQuotaExceededError)
              throw new HttpError(413, "storage_quota_exceeded", error.message);
            if (error instanceof ConversationBusyError)
              throw new HttpError(409, "conversation_busy", error.message);
            if (error instanceof InvalidCursorError)
              throw new HttpError(400, "invalid_request", error.message);
            if (error instanceof ModelKeyLimitError)
              throw new HttpError(409, "model_key_limit", error.message);
            if (error instanceof InvalidModelError)
              throw new HttpError(400, "invalid_model", error.message);
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
    if (!isConversationId(id)) throw new HttpError(404, "not_found", "conversation not found");
    return id;
  };

  /**
   * Open event streams in this process, in all and per tenant: each leases its tenant's pool and shares the tenant's
   * listening connection for as long as it lives (connection budget: docs/deploy.md#postgres).
   */
  let streamsOpen = 0;
  const openStreams = new Map<string, number>();

  const providerParam = (params: Record<string, string>): string => {
    const parsed = ModelProviderSchema.safeParse(params.provider);
    if (!parsed.success) throw new HttpError(404, "not_found", "model key not found");
    return parsed.data;
  };

  const routes: Route[] = [
    ["GET", "/healthz", () => json(200, { ok: true })],
    [
      "GET",
      "/v1/model-keys",
      authed("GET /v1/model-keys", async (_request, _params, principal) =>
        json(200, await listTenantModelKeys(deps, principal)),
      ),
    ],
    [
      "PUT",
      "/v1/model-keys/:provider",
      authed("PUT /v1/model-keys/:provider", async (request, params, principal) => {
        // The harness adapter's list (ADR 0008): a key for a provider no run can use would fail only at the first turn.
        const provider = params.provider ?? "";
        if (!deps.settings.modelProviders.includes(provider))
          throw new HttpError(
            400,
            "unknown_provider",
            `unknown model provider; supported: ${deps.settings.modelProviders.join(", ")}`,
          );
        const body = await readJson(request, PutModelKeyRequestSchema, { maxBytes: 16_384 });
        await setModelKey(deps, principal, provider, body.apiKey);
        return new Response(null, { status: 204 });
      }),
    ],
    [
      "DELETE",
      "/v1/model-keys/:provider",
      authed("DELETE /v1/model-keys/:provider", async (_request, params, principal) => {
        if (!(await removeModelKey(deps, principal, providerParam(params))))
          throw new NotFoundError("model key not found");
        return new Response(null, { status: 204 });
      }),
    ],
    [
      "POST",
      "/v1/conversations",
      authed("POST /v1/conversations", async (request, _params, principal) => {
        const body = await readJson(request, CreateConversationRequestSchema);
        return json(201, await inTenant(principal, (ctx) => createConversation(deps, ctx, body)));
      }),
    ],
    [
      "GET",
      "/v1/conversations",
      authed("GET /v1/conversations", async (request, _params, principal) => {
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
          await inTenant(principal, (ctx) => listTenantConversations(ctx, query.data)),
        );
      }),
    ],
    [
      "POST",
      "/v1/conversations/:id/messages",
      authed("POST /v1/conversations/:id/messages", async (request, params, principal) => {
        const id = conversationId(params);
        const body = await readJson(request, PostMessageRequestSchema, {
          maxBytes: MESSAGE_BODY_BYTES,
        });
        const storageBytes = principal.limits.storageBytes ?? deps.settings.defaultStorageBytes;
        return json(
          202,
          await inTenant(principal, (ctx) => postMessage(deps, ctx, id, body, storageBytes)),
        );
      }),
    ],
    [
      "GET",
      "/v1/conversations/:id",
      authed("GET /v1/conversations/:id", async (request, params, principal) => {
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
        return json(200, await inTenant(principal, (ctx) => getConversation(deps, ctx, id, page)));
      }),
    ],
    [
      "GET",
      "/v1/conversations/:id/events",
      authed("GET /v1/conversations/:id/events", async (request, params, principal) => {
        const id = conversationId(params);
        const header =
          request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after");
        const after = header === null ? 0 : Number(header);
        if (!Number.isInteger(after) || after < 0)
          throw new HttpError(400, "invalid_request", "Last-Event-ID must be a sequence number");
        if (streamsOpen >= deps.settings.maxStreamsPerProcess)
          throw new HttpError(
            503,
            "server_busy",
            `this server holds its maximum of ${deps.settings.maxStreamsPerProcess} open event streams; retry shortly, or read the conversation with GET /v1/conversations/:id`,
          );
        const open = openStreams.get(principal.tenantId) ?? 0;
        if (open >= deps.settings.maxStreamsPerTenant)
          throw new HttpError(
            429,
            "too_many_streams",
            `at most ${deps.settings.maxStreamsPerTenant} event streams may be open at once`,
          );
        streamsOpen++;
        openStreams.set(principal.tenantId, open + 1);
        let released = false;
        let lease: TenantLease | undefined;
        const release = async () => {
          if (released) return;
          released = true;
          streamsOpen--;
          const left = (openStreams.get(principal.tenantId) ?? 1) - 1;
          if (left > 0) openStreams.set(principal.tenantId, left);
          else openStreams.delete(principal.tenantId);
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
          if (!(await findConversation(lease.db, id)))
            throw new NotFoundError("conversation not found");
          const events = conversationEvents(
            deps,
            { tenantId: principal.tenantId, db: lease.db },
            id,
            after,
            request.signal,
            stillAllowed,
          );
          return sse(events, release);
        } catch (error) {
          await release();
          throw error;
        }
      }),
    ],
  ];
  return createRouter(routes);
}
