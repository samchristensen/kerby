# 0010. Tenant URLs leave through one egress guard

- Status: proposed
- Date: 2026-11-22

## Context

Tenants will give Kerby URLs: remote MCP tools (plan 0001 M7) and, later, custom provider base URLs. A process that
fetches a tenant's URL runs inside Railway's private network, next to Postgres, the other services and the cloud
metadata endpoint. Without a guard a tenant reaches those by naming them (`http://postgres.railway.internal`,
`http://169.254.169.254/`), by a DNS name that answers with a private address, by a name that answers publicly when
checked and privately when connected (DNS rebinding), or by a public server that redirects inward. Slow or huge
responses would tie up a worker or its memory.

## Decision

- **One package, one door.** [`packages/egress`](../../packages/egress/src/index.ts) exports `createEgressFetch(options)`,
  a `fetch`-shaped function (`(input, init) => Promise<Response>`), because the MCP SDK and provider clients accept a
  custom `fetch`. Every call to a tenant-supplied URL goes through it; nothing else fetches one. Node built-ins only
  (`node:http`, `node:https`, `node:net`'s `BlockList`, `node:dns`, `node:zlib`): no dependency, nothing to proxy.
- **Public addresses only.** Every address the host resolves to is checked against `BLOCKED_RANGES` (IANA
  special-purpose registries): this network, private, CGNAT, loopback, link-local (cloud metadata), IETF and
  documentation and benchmarking ranges, 6to4 relay, multicast, reserved; for IPv6 unspecified, loopback, IPv4-compatible,
  NAT64 local use, discard, Teredo and IETF assignments, documentation, 6to4, segment routing, unique-local (incl.
  `fd00:ec2::254`), link- and site-local, multicast. An IPv4-mapped (`::ffff:a.b.c.d`) or NAT64 (`64:ff9b::/96`) address
  is also checked as its IPv4 address. One blocked address refuses the host, even if others are public.
- **Connect to what was checked.** The request's `lookup` answers from the checked addresses, so the socket never asks
  DNS again and a rebinding answer cannot be used. The URL's hostname stays the TLS server name: SNI and certificate
  verification are unchanged. Each guard has its own keep-alive agents, so a pooled socket was opened to an allowed address.
- **Redirects by hand.** At most 5 (option), each hop parsed and checked like the first; https never redirects to http;
  Authorization, Proxy-Authorization and Cookie are dropped when the origin changes; 303 (and 301/302 after POST) become
  GET without a body, as `fetch` does. `redirect: "manual"` returns the 3xx, `"error"` refuses it.
- **Limits.** One deadline for the whole exchange, request body to last response byte (default 30 s); request body at
  most 8 MiB (buffered, so 307/308 can replay it); response at most 16 MiB after decoding (gzip, deflate, br, zstd are
  decoded, so a compression bomb hits the limit). Callers set tighter or looser values per use.
- **What is refused besides addresses.** Schemes other than http and https; a username or password in the URL (send
  credentials in a header, where they are not logged with the URL). Ports are not restricted: the address check is the
  boundary, and MCP servers listen on any port. Plain http is allowed: whether a tool may use it is the caller's
  policy, not the guard's.
- **Errors name the reason.** `EgressError.reason` is one of `invalid_url`, `scheme`, `credentials`, `dns`,
  `blocked_address`, `redirect`, `insecure_redirect`, `too_many_redirects`, `timeout`, `request_too_large`,
  `response_too_large`, `network`; the message names the host and the blocked range, never the path or query.

## Consequences

- Wiring is per caller: the MCP client (ADR 0019: the worker's listings and tool calls) and any custom base URL pass this
  `fetch`.
- A tenant cannot reach a service on Railway's private network or the metadata endpoint, even through a public redirect
  or a rebinding DNS server. It can still make Kerby call any public host on any port; per-tenant rate limits (G2)
  bound that.
- No outbound proxy: the guard runs in the process. If Kerby ever runs tenant-chosen networking outside Node's `http`
  (raw sockets, another client), that path needs its own check or an egress proxy.
- Streaming responses (SSE) live within the deadline; a long-lived MCP stream needs a caller-chosen `timeoutMs`.

## Amendment: the first caller, and named hosts for the development stack (2026-11-23)

- The worker passes this `fetch` to `packages/mcp` for every listing and call of a tenant's MCP server (ADR 0019), with
  `timeoutMs` from `TOOL_CALL_TIMEOUT_MS` (60 s).
- `allowedHosts`: host names (exact, case-insensitive) whose addresses skip the range check, so the Compose stack can reach
  an MCP server on the developer's machine (`host.docker.internal`, `make tools-e2e`). A redirect away from one is checked
  like any hop. The worker and the api (OAuth discovery and code exchange, ADR 0019) take them from `EGRESS_ALLOWED_HOSTS`
  and refuse to start with any unless `KERBY_ENVIRONMENT=development`, so production has none. On the api they are also
  the hosts from which OAuth accepts plain http.
