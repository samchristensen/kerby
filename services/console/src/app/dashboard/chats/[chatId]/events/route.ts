// The browser's event stream for a conversation: the api's stream, relayed. The browser holds only the session cookie,
// so the console adds the credential; the api decides what the person may see (ADR 0014).
import { consoleService } from "../../../../_lib/console.ts";
import { getChatAccess } from "../../../../_lib/session.ts";

// A stream is per request and per person: never cached or prerendered.
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ chatId: string }> },
): Promise<Response> {
  const access = await getChatAccess();
  if (!access) return new Response(null, { status: 401 });
  const { chatId } = await params;
  // A reconnecting EventSource says where it stopped in `Last-Event-ID`; its first request says it in `after`.
  const after =
    request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after");
  const upstream = await consoleService().chatEvents(access, chatId, after, request.signal);
  if (!upstream.ok || !upstream.body) {
    // The api's reason stays on the server; the browser needs only the status.
    return new Response(null, {
      status: upstream.status === 404 ? 404 : upstream.status >= 500 ? 502 : upstream.status,
    });
  }
  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
