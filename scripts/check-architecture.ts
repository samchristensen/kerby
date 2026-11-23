// The mechanical half of ARCHITECTURE.md. `make architecture` runs it; CI gates on it.
// Every message says what is wrong, how to fix it, and where the rule is explained: the message is
// what the agent reads when it fails, so it must be enough to fix the code without reading this file.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";

/** Lowest to highest. A layer may import its own layer and any layer to its left. */
const LAYERS = ["types", "config", "repo", "service", "runtime"] as const;

/** Every rule id; docs that say a rule is enforced name one of these (`make docs` checks). */
export const RULES = [
  "names",
  "deps",
  "imports",
  "layers",
  "tenancy",
  "providers",
  "config",
  "docker",
] as const;
type Rule = (typeof RULES)[number];
export type Violation = { rule: Rule; file: string; message: string };

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
type Pkg = Partial<Record<(typeof DEP_FIELDS)[number], Record<string, string>>> & { name?: string };
type Workspace = { kind: "packages" | "services" | "scripts"; dir: string; pkg: Pkg };
type Add = (rule: Rule, file: string, message: string) => void;

const SKIP_DIRS: Record<string, true> = {
  node_modules: true,
  dist: true,
  ".git": true,
  ".next": true,
};
const BUILTINS = new Set(builtinModules);
/** Direct access to the process environment: `process.env`, or `env` imported from `node:process`. */
const READS_ENV =
  /\bprocess\s*(?:\.|\?\.)\s*env\b|\bprocess\s*\[\s*["']env["']\s*\]|import\s*\{[^}]*\benv\b[^}]*\}\s*from\s*["'](?:node:)?process["']/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * External systems, each behind exactly one package. A dependency listed here may be imported only by
 * packages/<owner>; everything else uses that package. Add a row in the ADR that adopts a new system.
 */
const CONFINED = new Map<string, string>([
  ["pg", "db"],
  ["absurd-sdk", "durable"],
  ["@aws-sdk/client-s3", "blobs"],
  ["@aws-sdk/s3-request-presigner", "blobs"],
  ["@earendil-works/pi-durable", "runtime-pi-durable"],
  ["@earendil-works/pi-ai", "runtime-pi-durable"],
  ["@earendil-works/chord", "runtime-pi-durable"],
]);

function readJson(path: string): Pkg {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null) throw new Error(`${path} is not a JSON object`);
  return value as Pkg;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS[entry.name]) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** Module specifiers of every import, re-export and dynamic import in a source file. */
function specifiers(text: string): string[] {
  const found: string[] = [];
  for (const pattern of [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of text.matchAll(pattern)) if (match[1]) found.push(match[1]);
  }
  return found;
}

/**
 * Specifiers a source file loads for their values: every import, re-export and dynamic import except `import type` and
 * `export type`, which TypeScript erases (`verbatimModuleSyntax` keeps `import { type X }`, so that one counts).
 */
function valueSpecifiers(text: string): string[] {
  const found: string[] = [];
  for (const pattern of [
    /\b(?:import|export)\s+(?!type\b)[^;'"]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of text.matchAll(pattern)) if (match[1]) found.push(match[1]);
  }
  return found;
}

function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec);
}

/**
 * The layer of `path` under a service's `src`. A service built on Next.js keeps its routes in `src/app`, where Next.js
 * looks for them: that directory is the runtime layer (ADR 0014).
 */
function layerIndex(src: string, path: string, nextApp: boolean): number {
  const first = relative(src, path).split(sep)[0] ?? "";
  return (LAYERS as readonly string[]).indexOf(first === "app" && nextApp ? "runtime" : first);
}

export function checkArchitecture(root: string): Violation[] {
  const violations: Violation[] = [];
  const rel = (path: string) => relative(root, path);
  const add: Add = (rule, file, message) => violations.push({ rule, file: rel(file), message });

  const rootPkgPath = join(root, "package.json");
  const rootPkg = readJson(rootPkgPath);
  const catalog = readCatalog(root, add);

  // --- workspaces ---------------------------------------------------------------------------
  const workspaces: Workspace[] = [];
  for (const kind of ["packages", "services"] as const) {
    const base = join(root, kind);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS[entry.name]) continue;
      const dir = join(base, entry.name);
      if (!existsSync(join(dir, "package.json"))) {
        add(
          "names",
          dir,
          `no package.json. Fix: add one named "@kerby/${entry.name}", or delete the directory. See ARCHITECTURE.md#workspaces`,
        );
        continue;
      }
      workspaces.push({ kind, dir, pkg: readJson(join(dir, "package.json")) });
    }
  }
  if (existsSync(join(root, "scripts"))) {
    workspaces.push({ kind: "scripts", dir: join(root, "scripts"), pkg: rootPkg });
  }

  // --- names: @kerby/<dir>, unique across packages and services -----------------------------
  const byName = new Map<string, Workspace>();
  for (const ws of workspaces) {
    if (ws.kind === "scripts") continue;
    const expected = `@kerby/${basename(ws.dir)}`;
    if (ws.pkg.name !== expected) {
      add(
        "names",
        join(ws.dir, "package.json"),
        `name is "${ws.pkg.name}", expected "${expected}". Fix: rename it to match the directory. See ARCHITECTURE.md#workspaces`,
      );
    }
    const clash = byName.get(expected);
    if (clash) {
      add(
        "names",
        ws.dir,
        `directory name "${basename(ws.dir)}" is also used by ${rel(clash.dir)}. Fix: pick a name that is unique across packages/ and services/. See ARCHITECTURE.md#workspaces`,
      );
    }
    byName.set(expected, ws);
  }

  // --- deps: catalog: for external, workspace:* for internal, exact pins in the catalog -----
  for (const [name, version] of Object.entries(catalog)) {
    if (!EXACT_VERSION.test(version)) {
      add(
        "deps",
        join(root, "pnpm-workspace.yaml"),
        `catalog entry ${name} is "${version}", not an exact version. Fix: pin it (no ^ or ~). See ARCHITECTURE.md#dependencies`,
      );
    }
  }
  const manifests: [string, Pkg][] = [[rootPkgPath, rootPkg]];
  for (const ws of workspaces) {
    if (ws.kind !== "scripts") manifests.push([join(ws.dir, "package.json"), ws.pkg]);
  }
  for (const [path, pkg] of manifests) {
    for (const field of DEP_FIELDS) {
      for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
        const internal = name.startsWith("@kerby/");
        const wanted = internal ? "workspace:*" : "catalog:";
        if (spec === wanted) continue;
        const fix = internal
          ? `use "workspace:*"`
          : `add ${name} to the catalog in pnpm-workspace.yaml (exact version) and reference it as "catalog:"`;
        add(
          "deps",
          path,
          `${field}.${name} is "${spec}", expected "${wanted}". Fix: ${fix}. See ARCHITECTURE.md#dependencies`,
        );
      }
    }
  }

  // --- imports and layers -------------------------------------------------------------------
  const rootDev = new Set(Object.keys(rootPkg.devDependencies ?? {}));
  for (const ws of workspaces) {
    const declared = new Set(rootDev);
    for (const field of DEP_FIELDS) {
      for (const name of Object.keys(ws.pkg[field] ?? {})) declared.add(name);
    }
    const manifest =
      ws.kind === "scripts" ? "the root package.json" : `${rel(ws.dir)}/package.json`;
    const src = join(ws.dir, "src");
    // A Next.js service: `src/app` is its runtime layer, and Next.js bundles it apart from the rest (ADR 0014).
    const nextApp = ws.kind === "services" && declared.has("next") ? join(src, "app") : undefined;

    for (const file of walk(ws.dir)) {
      if (!/\.(?:m?ts|tsx)$/.test(file)) continue;
      const text = readFileSync(file, "utf8");
      if (ws.kind === "services" || (ws.kind === "packages" && basename(ws.dir) !== "config")) {
        if (READS_ENV.test(text)) {
          add(
            "config",
            file,
            `reads the process environment directly. Fix: declare the setting in the service's config schema and read it from the object loadConfig (@kerby/config) returns; config is read once at startup. See ARCHITECTURE.md#configuration`,
          );
        }
      }
      const importerLayer =
        ws.kind === "services" && !file.endsWith(".test.ts")
          ? layerIndex(src, file, nextApp !== undefined)
          : -1;
      if (nextApp && !relative(nextApp, file).startsWith("..") && !file.endsWith(".test.ts")) {
        for (const spec of valueSpecifiers(text)) {
          const kerby = packageName(spec).startsWith("@kerby/");
          const leavesApp =
            spec.startsWith(".") &&
            relative(nextApp, resolve(dirname(file), spec)).startsWith("..");
          if (kerby || leavesApp) {
            add(
              "layers",
              file,
              `imports the value of "${spec}" into src/app, which Next.js bundles: that code would load a second time inside the bundle, apart from the one src/index.ts built. Fix: \`import type\` it, and reach values through what src/index.ts installs (the console: consoleService() in src/app/_lib/console.ts). See ADR 0014`,
            );
          }
        }
      }
      for (const spec of specifiers(text)) {
        if (spec.startsWith(".")) {
          const target = resolve(dirname(file), spec);
          if (relative(ws.dir, target).startsWith("..")) {
            add(
              "imports",
              file,
              `relative path "${spec}" leaves ${rel(ws.dir)}. Fix: import the other workspace by name (@kerby/<package>), which means it must be a package. See ARCHITECTURE.md#workspaces`,
            );
            continue;
          }
          const targetLayer =
            importerLayer >= 0 ? layerIndex(src, target, nextApp !== undefined) : -1;
          if (targetLayer > importerLayer) {
            const from = LAYERS[importerLayer];
            add(
              "layers",
              file,
              `layer "${from}" imports "${spec}" from higher layer "${LAYERS[targetLayer]}". Fix: move the shared logic down to "${from}" or lower, or pass the dependency in as an argument. Order: ${LAYERS.join(" -> ")}. See ARCHITECTURE.md#layers`,
            );
          }
          continue;
        }
        if (spec.startsWith("node:") || BUILTINS.has(spec)) continue;
        const name = packageName(spec);
        if (name.startsWith("@kerby/")) {
          const target = byName.get(name);
          if (!target) {
            add(
              "imports",
              file,
              `"${name}" is not a workspace. Fix: create packages/${name.slice(7)} or correct the name. See ARCHITECTURE.md#workspaces`,
            );
            continue;
          }
          if (target.kind === "services") {
            add(
              "imports",
              file,
              `imports service ${name}. Services are never imported. Fix: put the shared type or schema in packages/contracts and import that; talk to the service over HTTP. See ARCHITECTURE.md#workspaces`,
            );
            continue;
          }
        }
        const owner = CONFINED.get(name);
        if (owner && !(ws.kind === "packages" && basename(ws.dir) === owner)) {
          add(
            "providers",
            file,
            `"${name}" may only be imported by packages/${owner}. Fix: use @kerby/${owner}; if it lacks what you need, add it there. See ARCHITECTURE.md#providers`,
          );
        }
        const isIndex =
          ws.kind === "services" && relative(ws.dir, file) === join("src", "index.ts");
        if (name.startsWith("@kerby/runtime-") && !isIndex) {
          add(
            "providers",
            file,
            `adapter ${name} may only be imported by a service's src/index.ts, which wires it in. Fix: depend on AgentRuntime from @kerby/agent and receive the adapter as an argument. See ARCHITECTURE.md#providers`,
          );
        }
        if (!declared.has(name)) {
          const wanted = name.startsWith("@kerby/") ? "workspace:*" : "catalog:";
          add(
            "deps",
            file,
            `imports "${name}" but ${manifest} does not declare it. Fix: add it as "${wanted}". See ARCHITECTURE.md#dependencies`,
          );
        }
      }
    }

    if (ws.kind === "services" && existsSync(src)) {
      for (const entry of readdirSync(src, { withFileTypes: true })) {
        const ok = entry.isDirectory()
          ? (LAYERS as readonly string[]).includes(entry.name) ||
            (entry.name === "app" && nextApp !== undefined)
          : entry.name === "index.ts" || entry.name.endsWith(".test.ts");
        if (!ok) {
          add(
            "layers",
            join(src, entry.name),
            `src/ may hold only index.ts, tests, and the layer directories (${LAYERS.join(", ")}; and app, a Next.js service's routes). Fix: move this into the layer it belongs to. See ARCHITECTURE.md#layers`,
          );
        }
      }
    }
  }

  // --- tenancy: control-plane tables name their tenant; tenant-plane tables live in the tenant's own database
  for (const ws of workspaces) {
    const migrations = join(ws.dir, "migrations");
    if (ws.kind === "scripts" || !existsSync(migrations)) continue;
    for (const file of walk(migrations)) {
      if (!file.endsWith(".sql")) continue;
      const plane = relative(migrations, file).split(sep)[0];
      if (plane === "control") checkTables(file, readFileSync(file, "utf8"), add);
      else if (plane !== "tenant") {
        add(
          "tenancy",
          file,
          "migration is in neither migrations/control/ nor migrations/tenant/. Fix: control/ for the operator database (tenants, keys, usage), tenant/ for what lives in each tenant's own database. See ARCHITECTURE.md#tenancy",
        );
      }
    }
  }

  // --- docker: every service is deployable and says when it is healthy -----------------------
  for (const ws of workspaces) {
    if (ws.kind !== "services") continue;
    const dockerfile = join(ws.dir, "Dockerfile");
    if (!existsSync(dockerfile)) {
      add(
        "docker",
        ws.dir,
        `no Dockerfile. Fix: add ${rel(dockerfile)} with \`dev\` and \`prod\` targets and a HEALTHCHECK, built from the repository root. See ARCHITECTURE.md#local-stack`,
      );
    } else if (!/^\s*HEALTHCHECK\b/m.test(readFileSync(dockerfile, "utf8"))) {
      add(
        "docker",
        dockerfile,
        "has no HEALTHCHECK. Fix: add a HEALTHCHECK that fails when the service cannot serve (Compose waits on it with `--wait`). See ARCHITECTURE.md#local-stack",
      );
    }
  }

  return violations;
}

function readCatalog(root: string, add: Add): Record<string, string> {
  const path = join(root, "pnpm-workspace.yaml");
  if (!existsSync(path)) {
    add(
      "deps",
      path,
      "missing. Fix: restore pnpm-workspace.yaml with a catalog: section. See ARCHITECTURE.md#dependencies",
    );
    return {};
  }
  const doc: unknown = parse(readFileSync(path, "utf8"));
  return (doc as { catalog?: Record<string, string> } | null)?.catalog ?? {};
}

/** Control-plane tables: `create table x (` ... a line starting with `)`. Each has tenant_id, or `-- global: <reason>` on the line above. */
function checkTables(file: string, sql: string, add: Add): void {
  const lines = sql.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?(\S+)/i.exec(lines[i] ?? "");
    if (!match) continue;
    let end = i + 1;
    while (end < lines.length && !/^\s*\)/.test(lines[end] ?? "")) end++;
    const body = lines.slice(i, end).join("\n");
    const global = /^--\s*global:\s*\S/.test((lines[i - 1] ?? "").trim());
    if (!global && !/\btenant_id\b/i.test(body)) {
      add(
        "tenancy",
        file,
        `control-plane table ${match[1]} has no tenant_id. Fix: add "tenant_id uuid not null"; if the table is not about one tenant, put "-- global: <reason>" on the line above CREATE TABLE. A table holding a tenant's data belongs in migrations/tenant/ instead. Close each table with ")" at the start of a line. See ARCHITECTURE.md#tenancy`,
      );
    }
  }
}

if (import.meta.main) {
  const violations = checkArchitecture(resolve(process.argv[2] ?? process.cwd()));
  for (const v of violations) console.error(`${v.file}: [${v.rule}] ${v.message}\n`);
  if (violations.length > 0) {
    console.error(
      `${violations.length} architecture violation(s). Fix the code; changing a rule needs an ADR.`,
    );
    process.exit(1);
  }
  console.log("architecture: ok");
}
