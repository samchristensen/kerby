// The console's second call to another service: the tenant API, over the private network (ADR 0014). The person's
// session token is the bearer credential; the api checks it and takes the tenant from it.
import type { ApiClient } from "../types/index.ts";

/** A request that is not a stream gets this long; a message post or a page of messages takes well under it. */
const REQUEST_TIMEOUT_MS = 30_000;

export function createApiClient(apiUrl: string): ApiClient {
  return ({ method, path, token, body, headers, stream, signal }) => {
    // An event stream lives as long as the browser keeps it, so only the caller's signal ends it.
    const signals = [
      ...(stream ? [] : [AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      ...(signal ? [signal] : []),
    ];
    return fetch(new URL(path, apiUrl), {
      method,
      headers: {
        ...headers,
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
    });
  };
}
