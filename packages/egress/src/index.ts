// The egress guard: the only way Kerby calls a URL a tenant gave it (ADR 0010). `createEgressFetch` returns a
// `fetch`-shaped function, because MCP and provider clients accept one, that refuses anything but a public address.
//
// - Every address a host resolves to is checked against `BLOCKED_RANGES` (private, loopback, link-local and cloud
//   metadata, CGNAT, unique-local, multicast, documentation, IPv4 inside IPv6); one blocked address refuses the host.
// - The connection goes to the addresses that were checked: a `lookup` that answers from them, never a second DNS
//   query, so a rebinding DNS server cannot swap in a private address. TLS still verifies the certificate against
//   the hostname (SNI is the hostname, not the address).
// - Redirects are followed here, at most `maxRedirects`, and every hop is checked like the first; https never
//   redirects to http, and credentials (Authorization, Cookie) are dropped when the origin changes.
// - One deadline covers the whole exchange, request body to the last response byte; request and (decoded)
//   response bodies have byte limits. Request bodies are buffered so a redirect can replay them.
// - Only http and https; no credentials in the URL (send them in a header). Any port: the address check is the
//   boundary, and MCP servers listen where they like.
import { lookup as dnsLookup } from "node:dns/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { pipeline, Readable, Transform, type TransformCallback } from "node:stream";
import zlib from "node:zlib";

/** Why the guard refused or ended an exchange. */
type EgressRefusal =
  | "invalid_url"
  | "scheme"
  | "credentials"
  | "dns"
  | "blocked_address"
  | "redirect"
  | "insecure_redirect"
  | "too_many_redirects"
  | "timeout"
  | "request_too_large"
  | "response_too_large"
  | "network";

/**
 * @public Egress has no caller yet (ADR 0010); callers tell refusals apart with `instanceof EgressError` and `reason`.
 */
export class EgressError extends Error {
  override name = "EgressError";
  readonly reason: EgressRefusal;
  constructor(reason: EgressRefusal, message: string, options?: ErrorOptions) {
    super(message, options);
    this.reason = reason;
  }
}

export type BlockedRange = { readonly range: string; readonly why: string };

/** Addresses a tenant URL may never reach (IANA special-purpose registries, RFC 6890 and successors). */
export const BLOCKED_RANGES: readonly BlockedRange[] = [
  { range: "0.0.0.0/8", why: "this network, unspecified" },
  { range: "10.0.0.0/8", why: "private" },
  { range: "100.64.0.0/10", why: "carrier-grade NAT" },
  { range: "127.0.0.0/8", why: "loopback" },
  { range: "169.254.0.0/16", why: "link-local, cloud metadata" },
  { range: "172.16.0.0/12", why: "private" },
  { range: "192.0.0.0/24", why: "IETF protocol assignments" },
  { range: "192.0.2.0/24", why: "documentation" },
  { range: "192.88.99.0/24", why: "6to4 relay" },
  { range: "192.168.0.0/16", why: "private" },
  { range: "198.18.0.0/15", why: "benchmarking" },
  { range: "198.51.100.0/24", why: "documentation" },
  { range: "203.0.113.0/24", why: "documentation" },
  { range: "224.0.0.0/4", why: "multicast" },
  { range: "240.0.0.0/4", why: "reserved, broadcast" },
  { range: "::/128", why: "unspecified" },
  { range: "::1/128", why: "loopback" },
  { range: "::/96", why: "IPv4-compatible" },
  { range: "64:ff9b:1::/48", why: "local NAT64" },
  { range: "100::/64", why: "discard" },
  { range: "2001::/23", why: "IETF protocol assignments, Teredo" },
  { range: "2001:db8::/32", why: "documentation" },
  { range: "2002::/16", why: "6to4" },
  { range: "3fff::/20", why: "documentation" },
  { range: "5f00::/16", why: "segment routing" },
  { range: "fc00::/7", why: "unique-local, cloud metadata" },
  { range: "fe80::/10", why: "link-local" },
  { range: "fec0::/10", why: "site-local" },
  { range: "ff00::/8", why: "multicast" },
];

type ResolvedAddress = { readonly address: string; readonly family: 4 | 6 };
/** Every address of a hostname. The default asks the system resolver (`dns.lookup`, all addresses). */
type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export type EgressOptions = {
  /** Default `BLOCKED_RANGES`. Tests narrow it so a loopback server can answer. */
  readonly blockedRanges?: readonly BlockedRange[];
  readonly resolve?: Resolver;
  /** Redirects followed before refusing; default 5. */
  readonly maxRedirects?: number;
  /** Whole exchange, first byte sent to last byte read; default 30 s. */
  readonly timeoutMs?: number;
  /** Default 8 MiB. */
  readonly maxRequestBytes?: number;
  /** Decoded bytes; default 16 MiB. */
  readonly maxResponseBytes?: number;
  /**
   * Host names (exact, case-insensitive) whose addresses skip the range check: the install's own services on its
   * private network, or an MCP server on this machine (ADR 0010, amended by 0024). A redirect away from one is checked
   * like any other hop.
   */
  readonly allowedHosts?: readonly string[];
};

export type EgressFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type Rule = BlockedRange & { readonly list: BlockList };

const MiB = 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY = new Set([204, 205, 304]);
// Set by Node from the URL and the body, or meaningless across a proxy hop; never taken from the caller.
const OWN_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "content-length",
]);
const CROSS_ORIGIN_DROP = ["authorization", "proxy-authorization", "cookie"];
const BODY_HEADERS = ["content-type", "content-encoding", "content-language", "content-location"];

const systemResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, order: "verbatim" })).map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));

function compile(ranges: readonly BlockedRange[]): Rule[] {
  return ranges.map((r) => {
    const [network, bits] = r.range.split("/");
    const family = network ? isIP(network) : 0;
    const prefix = Number(bits);
    if (!network || family === 0 || !Number.isInteger(prefix)) {
      throw new Error(`blocked range "${r.range}" is not CIDR (address/prefix)`);
    }
    const list = new BlockList();
    list.addSubnet(network, prefix, family === 6 ? "ipv6" : "ipv4");
    return { ...r, list };
  });
}

function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...fill, ...right].map((g) => Number.parseInt(g, 16));
}

/** The IPv4 address inside an IPv4-mapped (::ffff:0:0/96), -compatible (::/96) or NAT64 (64:ff9b::/96) address. */
function embeddedIPv4(address: string): string | undefined {
  const g = ipv6Groups(address);
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const embeds =
    (zero(0, 5) && (g[5] === 0xffff || g[5] === 0)) ||
    (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6));
  const hi = g[6] ?? 0;
  const lo = g[7] ?? 0;
  return embeds ? `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}` : undefined;
}

function blockedBy(rules: readonly Rule[], address: string): string | undefined {
  const family = isIP(address) === 6 ? "ipv6" : "ipv4";
  for (const rule of rules) {
    if (rule.list.check(address, family)) return `${rule.range} (${rule.why})`;
  }
  if (family === "ipv6") {
    const inner = embeddedIPv4(address);
    const why = inner ? blockedBy(rules, inner) : undefined;
    if (why) return `${why}, as ${inner} inside ${address}`;
  }
  return undefined;
}

function parseUrl(href: string): URL {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new EgressError("invalid_url", "not an absolute URL. Fix: pass http(s)://host/path");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EgressError(
      "scheme",
      `${url.protocol} URLs are refused; only http: and https: leave Kerby`,
    );
  }
  if (url.username || url.password) {
    throw new EgressError(
      "credentials",
      `${url.host}: credentials in the URL are refused. Fix: send them in a header (Authorization)`,
    );
  }
  return url;
}

function pinnedLookup(addresses: readonly ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const matching = addresses.filter((a) => !options.family || a.family === options.family);
    const first = matching[0];
    if (!first) {
      callback(
        Object.assign(new Error(`no IPv${options.family} address`), { code: "ENOTFOUND" }),
        "",
      );
    } else if (options.all) {
      callback(
        null,
        matching.map((a) => ({ address: a.address, family: a.family })),
      );
    } else {
      callback(null, first.address, first.family);
    }
  };
}

function decoderFor(encoding: string | null): Transform | undefined {
  switch (encoding?.trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    case "zstd":
      return zlib.createZstdDecompress();
    default:
      return undefined;
  }
}

async function readBody(
  body: ReadableStream<Uint8Array>,
  max: number,
  host: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const reader = body.getReader();
  const onAbort = () => void reader.cancel(signal.reason).catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return Buffer.concat(chunks);
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new EgressError(
          "request_too_large",
          `${host}: request body is over the ${max}-byte limit`,
        );
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function createEgressFetch(options: EgressOptions = {}): EgressFetch {
  const rules = compile(options.blockedRanges ?? BLOCKED_RANGES);
  const resolve = options.resolve ?? systemResolver;
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRequestBytes = options.maxRequestBytes ?? 8 * MiB;
  const maxResponseBytes = options.maxResponseBytes ?? 16 * MiB;
  const allowedHosts = new Set((options.allowedHosts ?? []).map((host) => host.toLowerCase()));
  // Own agents: a pooled socket was opened to an address these rules allowed.
  const agents = {
    http: new http.Agent({ keepAlive: true }),
    https: new https.Agent({ keepAlive: true }),
  };

  async function addressesOf(hostname: string): Promise<readonly ResolvedAddress[]> {
    const literal = isIP(hostname);
    let addresses: readonly ResolvedAddress[];
    if (literal) {
      addresses = [{ address: hostname, family: literal === 6 ? 6 : 4 }];
    } else {
      try {
        addresses = await resolve(hostname);
      } catch (error) {
        throw new EgressError("dns", `${hostname} did not resolve`, { cause: error });
      }
      if (addresses.length === 0) throw new EgressError("dns", `${hostname} has no addresses`);
    }
    if (allowedHosts.has(hostname.toLowerCase())) return addresses;
    for (const { address } of addresses) {
      if (!isIP(address)) throw new EgressError("dns", `${hostname} resolved to "${address}"`);
      const why = blockedBy(rules, address);
      if (why) {
        throw new EgressError(
          "blocked_address",
          `${literal ? address : `${hostname} resolves to ${address}, which`} is in blocked range ${why}. Only public addresses are reachable`,
        );
      }
    }
    return addresses;
  }

  async function exchange(
    url: URL,
    method: string,
    headers: Headers,
    body: Buffer | undefined,
    signal: AbortSignal,
  ): Promise<IncomingMessage> {
    const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
    const addresses = await addressesOf(hostname);
    signal.throwIfAborted();
    const outgoing: Record<string, string> = {};
    headers.forEach((value, name) => {
      if (!OWN_HEADERS.has(name)) outgoing[name] = value;
    });
    outgoing["accept-encoding"] ??= "gzip, deflate, br, zstd";
    if (body) outgoing["content-length"] = String(body.byteLength);
    const secure = url.protocol === "https:";
    const { promise, resolve: respond, reject } = Promise.withResolvers<IncomingMessage>();
    const req = (secure ? https : http).request(
      {
        protocol: url.protocol,
        hostname,
        port: url.port ? Number(url.port) : secure ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method,
        headers: outgoing,
        agent: secure ? agents.https : agents.http,
        lookup: pinnedLookup(addresses),
        signal,
      },
      respond,
    );
    req.on("error", (error) => {
      reject(
        signal.aborted
          ? signal.reason
          : new EgressError("network", `${url.host}: ${error.message}`, { cause: error }),
      );
    });
    req.end(body);
    return promise;
  }

  return async (input, init) => {
    const url = parseUrl(input instanceof Request ? input.url : String(input));
    const request = new Request(input, init);
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const deadline = new AbortController();
    const timer = setTimeout(
      () =>
        deadline.abort(
          new EgressError("timeout", `${url.host}: no complete response within ${timeoutMs} ms`),
        ),
      timeoutMs,
    );
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, deadline.signal])
      : deadline.signal;
    try {
      let current = url;
      let method = request.method;
      const headers = new Headers(request.headers);
      let body = request.body
        ? await readBody(request.body, maxRequestBytes, url.host, signal)
        : undefined;
      for (let hop = 0; ; hop++) {
        const res = await exchange(current, method, headers, body, signal);
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (REDIRECTS.has(status) && location !== undefined && request.redirect !== "manual") {
          res.destroy();
          if (request.redirect === "error") {
            throw new EgressError("redirect", `${current.host} redirected; redirect: "error"`);
          }
          let next: URL;
          try {
            next = parseUrl(new URL(location, current).href);
          } catch (error) {
            throw new EgressError("redirect", `${current.host} redirected to a refused URL`, {
              cause: error,
            });
          }
          if (current.protocol === "https:" && next.protocol === "http:") {
            throw new EgressError(
              "insecure_redirect",
              `${current.host} redirected from https to http (${next.host})`,
            );
          }
          if (hop + 1 > maxRedirects) {
            throw new EgressError(
              "too_many_redirects",
              `${url.host}: more than ${maxRedirects} redirects`,
            );
          }
          if (
            (status === 303 && method !== "GET" && method !== "HEAD") ||
            ((status === 301 || status === 302) && method === "POST")
          ) {
            method = "GET";
            body = undefined;
            for (const name of BODY_HEADERS) headers.delete(name);
          }
          if (next.origin !== current.origin) {
            for (const name of CROSS_ORIGIN_DROP) headers.delete(name);
          }
          current = next;
          continue;
        }
        return toResponse(res, current, hop > 0, method, signal, timer, maxResponseBytes);
      }
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
  };
}

function toResponse(
  res: IncomingMessage,
  url: URL,
  redirected: boolean,
  method: string,
  signal: AbortSignal,
  timer: NodeJS.Timeout,
  max: number,
): Response {
  const status = res.statusCode ?? 0;
  const headers = new Headers();
  for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
    headers.append(res.rawHeaders[i] ?? "", res.rawHeaders[i + 1] ?? "");
  }
  const init = { status, statusText: res.statusMessage ?? "", headers };
  const decoder = decoderFor(headers.get("content-encoding"));
  const declared = Number(headers.get("content-length") ?? Number.NaN);
  let response: Response;
  if (NULL_BODY.has(status) || method === "HEAD") {
    res.destroy();
    clearTimeout(timer);
    response = new Response(null, init);
  } else if (!decoder && declared > max) {
    res.destroy();
    throw new EgressError(
      "response_too_large",
      `${url.host}: response of ${declared} bytes is over the ${max}-byte limit`,
    );
  } else {
    let seen = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback: TransformCallback) {
        seen += chunk.length;
        if (seen > max) {
          callback(
            new EgressError(
              "response_too_large",
              `${url.host}: response is over the ${max}-byte limit`,
            ),
          );
        } else {
          callback(null, chunk);
        }
      },
    });
    const onAbort = () => limit.destroy(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    if (decoder) pipeline(res, decoder, limit, finish);
    else pipeline(res, limit, finish);
    response = new Response(Readable.toWeb(limit) as ReadableStream<Uint8Array>, init);
  }
  Object.defineProperties(response, {
    url: { value: url.href },
    redirected: { value: redirected },
  });
  return response;
}
