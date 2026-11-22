// Multi-tenant proof on the real Compose stack (plan 0002, T13; plan 0001, M6). Run with `make multitenant`.
//   1. two tenants, provisioned through the operator API, each with a conversation answered by the worker;
//   2. the cross-tenant attempt suite: conversations, event streams, database roles, tasks, object prefixes, keys;
//   3. suspension takes effect within the API's auth cache TTL, and only for that tenant;
//   4. a load run with N tenants (default 200): provisioning, a turn each, connections, memory, then deletion.
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { tenantDbPassword } from "@kerby/control-plane";

const API = `http://127.0.0.1:${process.env.KERBY_API_PORT ?? "8080"}`;
const SECRET = process.env.KERBY_TENANT_DB_SECRET ?? "local-dev-tenant-db-secret-0123456789";
const TENANTS = Number(process.env.KERBY_LOAD_TENANTS ?? "200");
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

/** Connect to `database` as `role` from inside the postgres container, over the network address (loopback is `trust` in the image); returns psql's error text, or "" on success. */
function connectAs(role: string, tenantId: string, database: string): string {
  const url = `postgresql://${role}:${tenantDbPassword(SECRET, tenantId)}@postgres:5432/${database}`;
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
  check(connectAs(a.dbRole, a.id, a.dbName) === "", "A's role can open A's database");
  check(
    /permission denied|not allowed/.test(connectAs(a.dbRole, a.id, b.dbName)),
    "A's role cannot open B's database",
  );
  check(
    /permission denied|not allowed/.test(connectAs(b.dbRole, b.id, a.dbName)),
    "B's role cannot open A's database",
  );
  // ...nor the maintenance databases or the template every tenant database is copied from.
  for (const database of ["postgres", "template1", "kerby_tenant_template"]) {
    check(
      connectAs(a.dbRole, a.id, database).includes(`permission denied for database "${database}"`),
      `A's role cannot open ${database}`,
    );
  }
  check(
    /password authentication failed/.test(connectAs(a.dbRole, b.id, a.dbName)),
    "a role with another tenant's derived password is refused",
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
  const latencies = (
    await pool(tenants, 40, (tenant) => converse(tenant.secret, "hello from the load run"))
  )
    .map((r) => r.ms)
    .sort((x, y) => x - y);
  const turnsMs = performance.now() - t1;
  clearInterval(sampler);
  const during = memory();

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
  ].join(" ");
}

async function main(): Promise<void> {
  console.log("bringing the stack up");
  compose("up", "-d", "--build", "--wait");
  const a = await provision("tenant-a");
  const b = await provision("tenant-b");
  await crossTenantSuite(a, b);
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
