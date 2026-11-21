// The tenant-facing API. Every route but /healthz authenticates a bearer API key and runs as that key's tenant.
import { CreateConversationRequestSchema, PostMessageRequestSchema } from "@kerby/contracts";
import { ConversationBusyError, findConversation, isConversationId } from "@kerby/conversations";
import type { TenantContext } from "@kerby/db";
import {
  bearerToken,
  createRouter,
  type FetchHandler,
  HttpError,
  json,
  type Route,
  readJson,
} from "@kerby/serve";
import { createAuthenticator } from "../service/auth.ts";
import {
  conversationEvents,
  createConversation,
  getConversation,
  InvalidModelError,
  postMessage,
  type StreamItem,
} from "../service/conversations.ts";
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

export function createApiApp(deps: ApiDeps): FetchHandler {
  const auth = createAuthenticator(deps.control, deps.settings.authCacheMs);

  /** Authenticate, then run `handler` with the tenant's context. The tenant id comes from the key only. */
  const authed =
    (
      handler: (
        request: Request,
        params: Record<string, string>,
        principal: Principal,
      ) => Promise<Response> | Response,
    ): Route[2] =>
    async (request, params) => {
      const presented = bearerToken(request);
      if (!presented)
        throw new HttpError(
          401,
          "unauthorized",
          "an API key is required: Authorization: Bearer <key>",
        );
      let principal: Principal;
      try {
        principal = await auth.authenticate(presented);
      } catch (error) {
        if (error instanceof UnauthorizedError)
          throw new HttpError(401, "unauthorized", "invalid API key");
        if (error instanceof TenantUnavailableError)
          throw new HttpError(403, "tenant_unavailable", error.message);
        throw error;
      }
      try {
        return await handler(request, params, principal);
      } catch (error) {
        if (error instanceof NotFoundError) throw new HttpError(404, "not_found", error.message);
        if (error instanceof ConversationBusyError)
          throw new HttpError(409, "conversation_busy", error.message);
        if (error instanceof InvalidModelError)
          throw new HttpError(400, "invalid_model", error.message);
        throw error;
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

  const routes: Route[] = [
    ["GET", "/healthz", () => json(200, { ok: true })],
    [
      "POST",
      "/v1/conversations",
      authed(async (request, _params, principal) => {
        const body = await readJson(request, CreateConversationRequestSchema);
        return json(201, await inTenant(principal, (ctx) => createConversation(deps, ctx, body)));
      }),
    ],
    [
      "POST",
      "/v1/conversations/:id/messages",
      authed(async (request, params, principal) => {
        const id = conversationId(params);
        const body = await readJson(request, PostMessageRequestSchema, {
          maxBytes: MESSAGE_BODY_BYTES,
        });
        return json(202, await inTenant(principal, (ctx) => postMessage(deps, ctx, id, body)));
      }),
    ],
    [
      "GET",
      "/v1/conversations/:id",
      authed(async (_request, params, principal) => {
        const id = conversationId(params);
        return json(200, await inTenant(principal, (ctx) => getConversation(deps, ctx, id)));
      }),
    ],
    [
      "GET",
      "/v1/conversations/:id/events",
      authed(async (request, params, principal) => {
        const id = conversationId(params);
        const header =
          request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after");
        const after = header === null ? 0 : Number(header);
        if (!Number.isInteger(after) || after < 0)
          throw new HttpError(400, "invalid_request", "Last-Event-ID must be a sequence number");
        // The pool stays leased for as long as the stream is open.
        const lease = await deps.pools.acquire(principal.tenantId);
        let released = false;
        const release = async () => {
          if (released) return;
          released = true;
          await lease.release();
        };
        try {
          // Look the conversation up before sending headers, so a wrong id is a 404 and not an empty stream.
          if (!(await findConversation(lease.db, id)))
            throw new NotFoundError("conversation not found");
          const events = conversationEvents(
            deps,
            { tenantId: principal.tenantId, db: lease.db },
            id,
            after,
            request.signal,
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
