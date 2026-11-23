// Multi-tenant proof on the real Compose stack (plan 0002, T13; plan 0001, M6). Run with `make multitenant`.
//   1. two tenants, provisioned through the operator API, each with a conversation answered by the worker;
//   2. the cross-tenant attempt suite: conversations, event streams, database roles, tasks, object prefixes, keys,
//      events and subscriptions, integrations without `tenant`, keys without `admin`;
//   3. a database password rotation: the old password is refused and api and worker log in with the new one;
//   4. suspension takes effect within the API's auth cache TTL, and only for that tenant;
//   5. a load run with N tenants (default 200): provisioning, a turn each, connections, memory, then deletion;
//   6. inside it, stream saturation on two api processes: both filled to their stream cap over many tenants,
//      peak Postgres connections per process and per tenant role (the budget in docs/deploy.md#postgres).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { openTenantDbPassword } from "@kerby/control-plane";
import { LISTEN_APPLICATION_NAME, TENANT_ROLE_CONNECTION_LIMIT } from "@kerby/db";
import { createSecretBox, splitKeys } from "@kerby/secrets";

const API = `http://127.0.0.1:${process.env.KERBY_API_PORT ?? "8080"}`;
// TENANT_DB_KEYS in compose.yaml: the script opens stored passwords as api and worker do.
const box = createSecretBox(
  splitKeys(process.env.KERBY_TENANT_DB_KEYS ?? "Ga5JSSydS48D60HoBOzAmEPJeUKLm3s44q+oguVov0M="),
);
const TENANTS = Number(process.env.KERBY_LOAD_TENANTS ?? "200");
/** Tenants whose streams fill the two api processes in the saturation phase; above the process cap, so the second
 * process fills with one stream per tenant: its worst case. */
const STREAM_TENANTS = Number(process.env.KERBY_STREAM_TENANTS ?? "100");
const KEEP = process.env.KERBY_E2E_KEEP === "1";
const AUTH_TTL_MS = 3_000; // AUTH_CACHE_SECONDS in compose.yaml

const sh = (cmd: string, args: string[]): string =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
const compose = (...args: string[]) => sh("docker", ["compose", ...args]);
const psql = (database: string, sql: string) =>
  compose("exec", "-T", "postgres", "psql", "-U", "postgres", "-d", database, "-tAc", sql);

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`multitenant failed: ${message}`);
  console.log(`  ok: ${message}`);
}

/** Run `fn` over `items`, at most `concurrency` at a time. */
async function pool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i] as T, i);
    }),
  );
  return out;
}

/** The operator API is not published: call it from inside the control container. */
async function operator(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const script = `
    const r = await fetch("http://127.0.0.1:8081/v1/operator${path}", {
      method: ${JSON.stringify(method)},
      headers: { authorization: "Bearer " + process.env.OPERATOR_TOKEN, "content-type": "application/json" },
      ${body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(body))},`}
    });
    const text = await r.text();
    console.log(JSON.stringify({ status: r.status, body: text ? JSON.parse(text) : {} }));`;
  const out = compose("exec", "-T", "control", "node", "--input-type=module", "-e", script);
  return JSON.parse(out) as { status: number; body: Record<string, unknown> };
}

type Tenant = { id: string; name: string; secret: string; dbName: string; dbRole: string };

async function provision(name: string): Promise<Tenant> {
  const response = await operator("POST", "/tenants", { name });
  check(response.status === 201, `provisioned ${name}`);
  const tenant = response.body.tenant as { id: string };
  const hex = tenant.id.replaceAll("-", "");
  return {
    id: tenant.id,
    name,
    secret: String(response.body.secret),
    dbName: `t_${hex}`,
    dbRole: `r_${hex}`,
  };
}

const api = async (key: string, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
};

async function converse(key: string, text: string): Promise<{ id: string; ms: number }> {
  const created = await api(key, "POST", "/v1/conversations", {});
  const id = String(created.body.id);
  const started = performance.now();
  const posted = await api(key, "POST", `/v1/conversations/${id}/messages`, { content: text });
  if (posted.status !== 202)
    throw new Error(`post failed: ${posted.status} ${JSON.stringify(posted.body)}`);
  for (let i = 0; i < 400; i++) {
    const view = await api(key, "GET", `/v1/conversations/${id}`);
    const messages = view.body.messages as unknown[];
    if (view.body.busy === false && messages.length >= 2)
      return { id, ms: performance.now() - started };
    await sleep(150);
  }
  throw new Error(`conversation ${id} was not answered in time`);
}

/** The tenant's database password as control stored it (sealed in the control database), opened. */
function storedPassword(tenantId: string): string {
  const sealed = psql(
    "kerby_control",
    `select encode(ciphertext, 'base64') from tenant_db_credentials where tenant_id = '${tenantId}'`,
  );
  return openTenantDbPassword(box, tenantId, Buffer.from(sealed.replaceAll("\n", ""), "base64"));
}

/** Connect to `database` as `role` from inside the postgres container, over the network address (loopback is `trust` in the image); returns psql's error text, or "" on success. */
function connectAs(role: string, password: string, database: string): string {
  const url = `postgresql://${role}:${encodeURIComponent(password)}@postgres:5432/${database}`;
  try {
    compose("exec", "-T", "postgres", "psql", url, "-tAc", "select 1");
    return "";
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error);
  }
}

async function crossTenantSuite(a: Tenant, b: Tenant): Promise<void> {
  console.log("cross-tenant attempts");
  const convA = await converse(a.secret, "tenant A secret");
  const convB = await converse(b.secret, "tenant B secret");
  check(convA.id !== convB.id, "each tenant has its own answered conversation");

  // Conversations and streams: B's key against A's ids.
  check(
    (await api(b.secret, "GET", `/v1/conversations/${convA.id}`)).status === 404,
    "B cannot read A's conversation",
  );
  check(
    (
      await api(b.secret, "POST", `/v1/conversations/${convA.id}/messages`, {
        content: "intrusion",
      })
    ).status === 404,
    "B cannot post to A's conversation",
  );
  check(
    (await api(b.secret, "GET", `/v1/conversations/${convA.id}/events`)).status === 404,
    "B cannot open A's event stream",
  );
  const viewA = await api(a.secret, "GET", `/v1/conversations/${convA.id}`);
  check(
    (viewA.body.messages as unknown[]).length === 2,
    "A's conversation is untouched by B's attempts",
  );

  // Databases: each tenant's role reaches its own database and no other (conversations, blob index and tasks live there).
  const passwordA = storedPassword(a.id);
  const passwordB = storedPassword(b.id);
  check(connectAs(a.dbRole, passwordA, a.dbName) === "", "A's role can open A's database");
  check(
    /permission denied|not allowed/.test(connectAs(a.dbRole, passwordA, b.dbName)),
    "A's role cannot open B's database",
  );
  check(
    /permission denied|not allowed/.test(connectAs(b.dbRole, passwordB, a.dbName)),
    "B's role cannot open A's database",
  );
  // ...nor the maintenance databases or the template every tenant database is copied from.
  for (const database of ["postgres", "template1", "kerby_tenant_template"]) {
    check(
      connectAs(a.dbRole, passwordA, database).includes(
        `permission denied for database "${database}"`,
      ),
      `A's role cannot open ${database}`,
    );
  }
  check(
    /password authentication failed/.test(connectAs(a.dbRole, passwordB, a.dbName)),
    "A's role with B's stored password is refused",
  );
  check(
    /password authentication failed/.test(
      connectAs(a.dbRole, randomBytes(32).toString("base64url"), a.dbName),
    ),
    "A's role with a wrong password is refused",
  );
  check(
    psql(a.dbName, "select count(*) from absurd.t_turns") === "1",
    "A's tasks are in A's database only",
  );
  check(
    psql(b.dbName, "select count(*) from absurd.t_turns") === "1",
    "B's tasks are in B's database only",
  );

  // Object prefixes: an export lists only the tenant's own prefix.
  const exportA = await operator("POST", `/tenants/${a.id}/export`);
  // The URL names the bucket's endpoint as control reaches it (`rustfs:9000`), so download it from there.
  const download = `const r = await fetch(${JSON.stringify(String(exportA.body.objectsUrl))}); if (!r.ok) throw new Error("download " + r.status); process.stdout.write(await r.text());`;
  const keys = JSON.parse(
    compose("exec", "-T", "control", "node", "--input-type=module", "-e", download),
  ) as {
    key: string;
  }[];
  check(
    keys.length >= 2 && exportA.body.objectPrefix === `t/${a.id}/`,
    "A's object listing is under A's prefix",
  );
  check(
    keys.every((k) => k.key.startsWith("conversations/")),
    "A's objects are A's conversation messages",
  );

  // Keys: a key authenticates one tenant; a revoked key is refused; a fabricated id is refused.
  const extra = await operator("POST", `/tenants/${a.id}/keys`, { label: "temp" });
  const extraSecret = String(extra.body.secret);
  check(
    (await api(extraSecret, "GET", `/v1/conversations/${convA.id}`)).status === 200,
    "a second key of A reads A's conversation",
  );
  check(
    (await api(extraSecret, "GET", `/v1/conversations/${convB.id}`)).status === 404,
    "...and not B's",
  );
  const keyId = String((extra.body.apiKey as { id: string }).id);
  await operator("DELETE", `/tenants/${a.id}/keys/${keyId}`);
  await sleep(AUTH_TTL_MS + 1000);
  check(
    (await api(extraSecret, "GET", `/v1/conversations/${convA.id}`)).status === 401,
    "a revoked key is refused once the auth cache expires",
  );
  check(
    (await api(`kb_${"0".repeat(12)}_${"A".repeat(43)}`, "GET", `/v1/conversations/${convA.id}`))
      .status === 401,
    "a fabricated key is refused",
  );

  await integrationSuite(a, b, convA.id);
}

/** An integration of `tenant` with `scopes`, made as the console does (it has no public route), and a key for it through the operator API. */
async function integrationKey(tenant: Tenant, name: string, scopes: string[]): Promise<string> {
  const integrationId = psql(
    "kerby_control",
    `insert into integrations (tenant_id, name, scopes) values ('${tenant.id}', '${name}', array[${scopes
      .map((scope) => `'${scope}'`)
      .join(", ")}]) returning id`,
  ).split("\n")[0];
  const created = await operator("POST", `/tenants/${tenant.id}/keys`, {
    label: name,
    integrationId,
  });
  check(
    created.status === 201 &&
      (created.body.apiKey as { integrationId: string }).integrationId === integrationId,
    `a key for A's ${name} integration`,
  );
  return String(created.body.secret);
}

/** The ids of every event `key` can pull, from the start of the log. */
async function pullEvents(key: string): Promise<{ id: string; body: string }[]> {
  const pulled = await api(key, "GET", "/v1/events?limit=500");
  check(pulled.status === 200, `GET /v1/events answers 200 (${pulled.status})`);
  return (pulled.body.events as { id: string }[]).map((event) => ({
    id: event.id,
    body: JSON.stringify(event),
  }));
}

/** Events, subscriptions and integrations (ADR 0019, 0020): across tenants, across integrations, and by scope. */
async function integrationSuite(a: Tenant, b: Tenant, convA: string): Promise<void> {
  console.log("integration and event isolation");
  const eventsA = await pullEvents(a.secret);
  check(
    eventsA.some((event) => event.body.includes(convA)),
    "A's default key pulls A's conversation events",
  );
  const idsA = new Set(eventsA.map((event) => event.id));
  const eventsB = await pullEvents(b.secret);
  check(
    eventsB.every((event) => !idsA.has(event.id) && !event.body.includes(convA)),
    "B's key pulls none of A's events",
  );

  // A subscription of A's, probed with B's key on every route.
  const created = await api(a.secret, "POST", "/v1/subscriptions", {
    destination: { kind: "webhook", url: "https://example.com/kerby-hook" },
    types: ["*"],
  });
  check(created.status === 201, `A creates a subscription (${created.status})`);
  const subscriptionId = String((created.body.subscription as { id: string }).id);
  const event = eventsA[0]?.id ?? "";
  const probes: [string, string, unknown?][] = [
    ["GET", `/v1/subscriptions/${subscriptionId}`],
    ["PATCH", `/v1/subscriptions/${subscriptionId}`, { enabled: false }],
    ["POST", `/v1/subscriptions/${subscriptionId}/test`],
    ["GET", `/v1/subscriptions/${subscriptionId}/deliveries`],
    ["POST", `/v1/subscriptions/${subscriptionId}/redeliver`, { eventId: event }],
    ["DELETE", `/v1/subscriptions/${subscriptionId}`],
  ];
  for (const [method, path, body] of probes) {
    const status = (await api(b.secret, method, path, body)).status;
    check(status === 404, `B gets 404 on ${method} ${path} of A's subscription (${status})`);
  }
  check(
    (await api(a.secret, "GET", `/v1/subscriptions/${subscriptionId}`)).status === 200,
    "A's subscription survives B's attempts",
  );

  // A second integration of A without `tenant`: it sees only its own work.
  const own = await integrationKey(a, "own-only", ["conversations", "events"]);
  const ownStatus = (await api(own, "GET", `/v1/conversations/${convA}`)).status;
  check(
    ownStatus === 404,
    `an integration without tenant gets 404 on another's conversation (${ownStatus})`,
  );
  const ownEvents = await pullEvents(own);
  check(
    ownEvents.every((e) => !idsA.has(e.id) && !e.body.includes(convA)),
    "...and pulls none of its events",
  );

  // Without `admin`, subscriptions are refused.
  const listed = (await api(own, "GET", "/v1/subscriptions")).status;
  check(listed === 403, `a key without admin gets 403 on /v1/subscriptions (${listed})`);

  check(
    (await api(a.secret, "DELETE", `/v1/subscriptions/${subscriptionId}`)).status === 204,
    "A deletes its subscription",
  );
}

async function rotationSuite(a: Tenant, b: Tenant): Promise<void> {
  console.log("database password rotation");
  const before = storedPassword(a.id);
  const untouched = storedPassword(b.id);
  check(
    (await operator("POST", `/tenants/${a.id}/rotate-db-password`)).status === 200,
    "rotated A's database password through the operator API",
  );
  const after = storedPassword(a.id);
  check(after !== before, "A has a new stored password");
  check(
    /password authentication failed/.test(connectAs(a.dbRole, before, a.dbName)),
    "A's old password is refused",
  );
  check(connectAs(a.dbRole, after, a.dbName) === "", "A's new password opens A's database");
  check(storedPassword(b.id) === untouched, "B's password is unchanged");
  // End every session of A's role: the api's and the worker's pools must log in again, and are refused the old password
  // (28P01) before they resolve the new one.
  psql(
    "postgres",
    `select count(pg_terminate_backend(pid)) from pg_stat_activity where usename = '${a.dbRole}'`,
  );
  check(
    (await converse(a.secret, "after the rotation")).id !== "",
    "A's conversation is answered after the rotation (api and worker reconnected)",
  );
}

async function suspensionSuite(a: Tenant, b: Tenant): Promise<void> {
  console.log("suspension");
  check(
    (await api(a.secret, "POST", "/v1/conversations", {})).status === 201,
    "A works before suspension (its key is now cached)",
  );
  const suspendedAt = performance.now();
  check((await operator("POST", `/tenants/${a.id}/suspend`)).status === 200, "suspended A");
  let refusedAfter = -1;
  while (performance.now() - suspendedAt < AUTH_TTL_MS + 3000) {
    if ((await api(a.secret, "POST", "/v1/conversations", {})).status === 403) {
      refusedAfter = performance.now() - suspendedAt;
      break;
    }
    await sleep(100);
  }
  check(
    refusedAfter >= 0 && refusedAfter <= AUTH_TTL_MS + 1000,
    `A was refused ${Math.round(refusedAfter)} ms after suspension (cache TTL ${AUTH_TTL_MS} ms)`,
  );
  check((await api(b.secret, "POST", "/v1/conversations", {})).status === 201, "B is unaffected");
  await operator("POST", `/tenants/${a.id}/resume`);
  await sleep(AUTH_TTL_MS + 500);
  check(
    (await api(a.secret, "POST", "/v1/conversations", {})).status === 201,
    "A works again after resume",
  );
}

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

type Stream = { controller: AbortController; reader: ReadableStreamDefaultReader<Uint8Array> };
type Opened = { stream: Stream } | { status: number; code: string };

/** Open a conversation's event stream on `base` and wait for its first bytes. */
async function openStream(base: string, key: string, conversationId: string): Promise<Opened> {
  const controller = new AbortController();
  const response = await fetch(`${base}/v1/conversations/${conversationId}/events`, {
    headers: { authorization: `Bearer ${key}` },
    signal: controller.signal,
  });
  if (response.status !== 200 || !response.body) {
    const body = (await response.json()) as { error?: { code?: string } };
    return { status: response.status, code: body.error?.code ?? "" };
  }
  const reader = response.body.getReader();
  await reader.read(); // ": open"
  return { stream: { controller, reader } };
}

/** Read `stream` until it carries the persisted message `seq` (replayed or live). */
async function waitForSeq(stream: Stream, seq: number): Promise<void> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 30_000;
  while (!text.includes(`id: ${seq}\n`)) {
    if (Date.now() > deadline) throw new Error(`stream never carried message ${seq}`);
    const { done, value } = await stream.reader.read();
    if (done) throw new Error(`stream ended before message ${seq}`);
    text += decoder.decode(value, { stream: true });
  }
}

/**
 * A second api process. Compose publishes the api on one fixed port, so `--scale api=2` cannot bind a second
 * replica: this is a one-off container of the same service and image on a random loopback port.
 */
async function secondApi(): Promise<{ container: string; base: string }> {
  const container = compose("run", "-d", "--no-deps", "-p", "127.0.0.1::8080", "api");
  const port = sh("docker", ["port", container, "8080/tcp"]).split("\n")[0]?.split(":").at(-1);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    const healthy = await fetch(`${base}/healthz`).then(
      (r) => r.ok,
      () => false,
    );
    if (healthy) return { container, base };
    await sleep(500);
  }
  throw new Error(`the second api (${container}) never became healthy`);
}

/** Client connections to Postgres right now, by process (container name), application and role. */
function activity(names: ReadonlyMap<string, string>) {
  const rows = psql(
    "postgres",
    `select host(client_addr), application_name, usename, count(*) from pg_stat_activity
      where backend_type = 'client backend' and client_addr is not null group by 1, 2, 3`,
  );
  return rows
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [addr = "", app = "", role = "", n = "0"] = line.split("|");
      return { process: names.get(addr) ?? addr, app, role, n: Number(n) };
    });
}

type LoadTenant = { id: string; secret: string; conversationId: string };

/**
 * Fill two api processes with event streams over `tenants` (round robin, one tenant database each) until each refuses
 * with 503, hold them while sampling `pg_stat_activity`, check a live message reaches every stream of one tenant on
 * both processes, then close everything and check the listening connections are gone.
 */
async function streamSaturation(tenants: readonly LoadTenant[]): Promise<string> {
  console.log(`stream saturation: two api processes, streams over ${tenants.length} tenants`);
  const first = tenants[0];
  if (!first) throw new Error("stream saturation needs at least one tenant");
  const second = await secondApi();
  const ipOf = (container: string) =>
    sh("docker", [
      "inspect",
      "-f",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      container,
    ]);
  const names = new Map<string, string>([
    [ipOf(compose("ps", "-q", "api")), "api-1"],
    [ipOf(second.container), "api-2"],
    [ipOf(compose("ps", "-q", "worker")), "worker"],
    [ipOf(compose("ps", "-q", "control")), "control"],
  ]);
  const streams: { tenantId: string; stream: Stream }[] = [];
  const closeAll = () => {
    for (const { stream } of streams.splice(0)) stream.controller.abort();
  };
  try {
    // One tenant up to its own cap on one process.
    let perTenant = 0;
    for (;;) {
      const opened = await openStream(API, first.secret, first.conversationId);
      if ("stream" in opened) {
        streams.push({ tenantId: first.id, stream: opened.stream });
        perTenant++;
        continue;
      }
      check(
        opened.status === 429 && opened.code === "too_many_streams",
        `one tenant is refused (429 too_many_streams) past ${perTenant} streams on one process`,
      );
      break;
    }

    // Both processes up to their own cap, round robin over every tenant.
    const perProcess: number[] = [];
    for (const [name, base] of [
      ["api-1", API],
      ["api-2", second.base],
    ] as const) {
      let open = base === API ? perTenant : 0;
      let refused: { status: number; code: string } | undefined;
      while (!refused) {
        let openedThisRound = 0;
        for (const tenant of tenants) {
          const opened = await openStream(base, tenant.secret, tenant.conversationId);
          if ("stream" in opened) {
            streams.push({ tenantId: tenant.id, stream: opened.stream });
            open++;
            openedThisRound++;
          } else if (opened.status !== 429) {
            refused = opened;
            break;
          }
        }
        if (!refused && openedThisRound === 0)
          throw new Error(
            `every tenant is at its stream cap before ${name} is full: raise KERBY_STREAM_TENANTS`,
          );
      }
      check(
        refused.status === 503 && refused.code === "server_busy",
        `${name} is refused (503 server_busy) past ${open} streams`,
      );
      perProcess.push(open);
    }

    // Hold at saturation for longer than the pools' idle timeout (10 s) and the streams' poll period (5 s).
    let peakTotal = 0;
    let peakPerRole = 0;
    let peakPerRoleProcess = 0;
    const peakByProcess = new Map<string, number>();
    const peakListeners = new Map<string, number>();
    const raise = (peaks: Map<string, number>, sums: Map<string, number>) => {
      for (const [key, n] of sums) peaks.set(key, Math.max(peaks.get(key) ?? 0, n));
    };
    for (let i = 0; i < 15; i++) {
      const rows = activity(names);
      const sumBy = (key: (row: (typeof rows)[number]) => string | undefined) => {
        const sums = new Map<string, number>();
        for (const row of rows) {
          const k = key(row);
          if (k !== undefined) sums.set(k, (sums.get(k) ?? 0) + row.n);
        }
        return sums;
      };
      const tenantRole = (row: (typeof rows)[number]) => row.role.startsWith("r_");
      peakTotal = Math.max(
        peakTotal,
        rows.reduce((sum, row) => sum + row.n, 0),
      );
      raise(
        peakByProcess,
        sumBy((row) => row.process),
      );
      raise(
        peakListeners,
        sumBy((row) => (row.app === LISTEN_APPLICATION_NAME ? row.process : undefined)),
      );
      for (const n of sumBy((row) => (tenantRole(row) ? row.role : undefined)).values())
        peakPerRole = Math.max(peakPerRole, n);
      for (const n of sumBy((row) =>
        tenantRole(row) ? `${row.role}@${row.process}` : undefined,
      ).values())
        peakPerRoleProcess = Math.max(peakPerRoleProcess, n);
      await sleep(1000);
    }
    const memory = sh("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{.MemUsage}}",
      compose("ps", "-q", "postgres"),
    ]);
    check(
      peakPerRole <= TENANT_ROLE_CONNECTION_LIMIT,
      `no tenant role held more than TENANT_ROLE_CONNECTION_LIMIT (${TENANT_ROLE_CONNECTION_LIMIT}) connections (peak ${peakPerRole})`,
    );
    for (const name of ["api-1", "api-2"])
      check(
        (peakListeners.get(name) ?? 0) <= tenants.length,
        `${name} held at most one listening connection per tenant (${peakListeners.get(name) ?? 0} for ${tenants.length} tenants)`,
      );

    // A message posted now reaches every stream the first tenant holds, on both processes.
    const posted = await api(
      first.secret,
      "POST",
      `/v1/conversations/${first.conversationId}/messages`,
      { content: "to every stream" },
    );
    check(posted.status === 202, "a message posted during saturation is accepted");
    const mine = streams.filter((s) => s.tenantId === first.id);
    await Promise.all(mine.map(({ stream }) => waitForSeq(stream, Number(posted.body.seq))));
    check(true, `all ${mine.length} of that tenant's streams on both processes carried it`);

    closeAll();
    let listening = -1;
    for (let i = 0; i < 40 && listening !== 0; i++) {
      await sleep(250);
      listening = activity(names)
        .filter((row) => row.app === LISTEN_APPLICATION_NAME && row.process.startsWith("api"))
        .reduce((sum, row) => sum + row.n, 0);
    }
    check(listening === 0, "closing every stream closed both api processes' listening connections");

    const list = (peaks: Map<string, number>) =>
      [...peaks].map(([name, n]) => `${name} ${n}`).join(", ");
    return [
      `Stream saturation: per-tenant cap ${perTenant}, process caps ${perProcess.join(" and ")} streams over ${tenants.length} tenants;`,
      `peak ${peakTotal} client connections (${list(peakByProcess)}; listening: ${list(peakListeners)});`,
      `peak per tenant role ${peakPerRole} in all, ${peakPerRoleProcess} from one process; Postgres memory ${memory}.`,
    ].join(" ");
  } finally {
    closeAll();
    sh("docker", ["rm", "-f", second.container]);
  }
}

async function loadRun(): Promise<string> {
  console.log(`load run: ${TENANTS} tenants`);
  const memory = () =>
    sh("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{.Name}} {{.MemUsage}}",
      ...compose("ps", "-q", "api", "worker", "control", "postgres").split("\n"),
    ]);
  const before = memory();
  let peakConnections = 0;
  const sampler = setInterval(() => {
    try {
      peakConnections = Math.max(
        peakConnections,
        Number(psql("postgres", "select count(*) from pg_stat_activity")),
      );
    } catch {
      // a sample missed is fine
    }
  }, 1000);

  const t0 = performance.now();
  const tenants = await pool(
    Array.from({ length: TENANTS }, (_, i) => `load-${i}`),
    8,
    async (name) => {
      const response = await operator("POST", "/tenants", { name });
      if (response.status !== 201)
        throw new Error(`provisioning ${name}: ${JSON.stringify(response)}`);
      const tenant = response.body.tenant as { id: string };
      return { id: tenant.id, secret: String(response.body.secret) };
    },
  );
  const provisioningMs = performance.now() - t0;

  const t1 = performance.now();
  const answered = await pool(tenants, 40, (tenant) =>
    converse(tenant.secret, "hello from the load run"),
  );
  const latencies = answered.map((r) => r.ms).sort((x, y) => x - y);
  const turnsMs = performance.now() - t1;
  clearInterval(sampler);
  const during = memory();

  const saturation = await streamSaturation(
    tenants
      .slice(0, STREAM_TENANTS)
      .map((tenant, i) => ({ ...tenant, conversationId: answered[i]?.id ?? "" })),
  );

  const t2 = performance.now();
  await pool(tenants, 8, async (tenant) => {
    const response = await operator("DELETE", `/tenants/${tenant.id}`);
    if (response.status !== 204) throw new Error(`deleting ${tenant.id}: ${response.status}`);
  });
  const deletionMs = performance.now() - t2;

  const seconds = (ms: number) => (ms / 1000).toFixed(1);
  return [
    `${TENANTS} tenants: provisioned in ${seconds(provisioningMs)} s (${Math.round(provisioningMs / TENANTS)} ms each, 8 at a time),`,
    `one turn each in ${seconds(turnsMs)} s (post to answer p50 ${Math.round(percentile(latencies, 0.5))} ms, p95 ${Math.round(percentile(latencies, 0.95))} ms, max ${Math.round(latencies.at(-1) ?? 0)} ms),`,
    `peak ${peakConnections} Postgres connections, deleted in ${seconds(deletionMs)} s.`,
    `Memory before: ${before.replaceAll("\n", "; ")}. During: ${during.replaceAll("\n", "; ")}.`,
    saturation,
  ].join(" ");
}

async function main(): Promise<void> {
  console.log("bringing the stack up");
  compose("up", "-d", "--build", "--wait");
  const a = await provision("tenant-a");
  const b = await provision("tenant-b");
  await crossTenantSuite(a, b);
  await rotationSuite(a, b);
  await suspensionSuite(a, b);
  console.log(`\nresult: ${await loadRun()}`);

  // Deleting every tenant left only the two above (and the template and control databases).
  const tenantDatabases = Number(
    psql("postgres", "select count(*) from pg_database where datname like 't\\_%'"),
  );
  check(
    tenantDatabases === 2,
    `after deleting the load tenants only tenant-a and tenant-b databases remain (${tenantDatabases})`,
  );
  const roles = Number(
    psql("postgres", "select count(*) from pg_roles where rolname like 'r\\_%'"),
  );
  check(roles === 2, `...and only their two roles (${roles})`);
  console.log("multitenant passed");
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
  try {
    console.error(compose("logs", "--tail", "40", "worker", "api", "control"));
  } catch {
    // no stack to read
  }
} finally {
  if (!KEEP) compose("down", "--volumes", "--remove-orphans", "--rmi", "local");
}
process.exit(failed ? 1 : 0);
