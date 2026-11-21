import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkArchitecture } from "./check-architecture.ts";

// Fixture sources are built with JSON.stringify so this file holds no literal import statements for the checker to read.
const imp = (spec: string) => `import { x } from ${JSON.stringify(spec)};\n`;
const pkg = (name: string, deps: Record<string, string> = {}) =>
  JSON.stringify({ name, dependencies: deps });

const BASE: Record<string, string> = {
  "package.json": JSON.stringify({ name: "root", devDependencies: { yaml: "catalog:" } }),
  "pnpm-workspace.yaml": 'catalog:\n  yaml: "2.9.1"\n',
  "packages/contracts/package.json": pkg("@kerby/contracts"),
  "packages/contracts/src/index.ts": "export const x = 1;\n",
  "services/api/package.json": pkg("@kerby/api", { "@kerby/contracts": "workspace:*" }),
  "services/api/src/index.ts": imp("./runtime/http.ts"),
  "services/api/src/runtime/http.ts": imp("../service/chats.ts"),
  "services/api/src/service/chats.ts": imp("../repo/chats.ts"),
  "services/api/src/repo/chats.ts": imp("@kerby/contracts") + imp("../types/chat.ts"),
  "services/api/src/types/chat.ts": "export const x = 1;\n",
};

const roots: string[] = [];
function tree(overrides: Record<string, string | null> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "kerby-arch-"));
  roots.push(root);
  const files = { ...BASE, ...overrides };
  for (const [path, content] of Object.entries(files)) {
    if (content === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const rules = (root: string) => checkArchitecture(root).map((v) => `${v.rule}:${v.file}`);

describe("checkArchitecture", () => {
  it("accepts a tree that follows every rule", () => {
    expect(checkArchitecture(tree())).toEqual([]);
  });

  it("rejects importing a service, even by package name", () => {
    const root = tree({
      "services/worker/package.json": pkg("@kerby/worker", { "@kerby/api": "workspace:*" }),
      "services/worker/src/index.ts": imp("@kerby/api"),
    });
    expect(rules(root)).toEqual(["imports:services/worker/src/index.ts"]);
  });

  it("rejects a relative import that leaves the workspace", () => {
    const root = tree({ "services/api/src/index.ts": imp("../../worker/src/index.ts") });
    expect(rules(root)).toEqual(["imports:services/api/src/index.ts"]);
  });

  it("rejects a lower layer importing a higher one, and names the fix", () => {
    const root = tree({ "services/api/src/repo/chats.ts": imp("../service/chats.ts") });
    const [violation] = checkArchitecture(root);
    expect(violation?.rule).toBe("layers");
    expect(violation?.message).toContain('layer "repo" imports');
    expect(violation?.message).toContain("ARCHITECTURE.md#layers");
  });

  it("lets tests import any layer", () => {
    const root = tree({ "services/api/src/repo/chats.test.ts": imp("../runtime/http.ts") });
    expect(checkArchitecture(root)).toEqual([]);
  });

  it("rejects source files outside index.ts and the layer directories", () => {
    const root = tree({ "services/api/src/helpers.ts": "export const x = 1;\n" });
    expect(rules(root)).toEqual(["layers:services/api/src/helpers.ts"]);
  });

  it("rejects an undeclared dependency and a non-catalog version", () => {
    const root = tree({
      "services/api/package.json": pkg("@kerby/api", {
        "@kerby/contracts": "workspace:*",
        zod: "^4.0.0",
      }),
      "services/api/src/types/chat.ts": imp("zod"),
    });
    expect(rules(root)).toEqual(["deps:services/api/package.json"]);
  });

  it("rejects a package imported but not declared", () => {
    const root = tree({ "services/api/src/types/chat.ts": imp("zod") });
    expect(rules(root)).toEqual(["deps:services/api/src/types/chat.ts"]);
  });

  it("rejects a catalog entry that is not an exact pin", () => {
    const root = tree({ "pnpm-workspace.yaml": 'catalog:\n  yaml: "^2.9.1"\n' });
    expect(rules(root)).toEqual(["deps:pnpm-workspace.yaml"]);
  });

  it("rejects a workspace whose name does not match its directory", () => {
    const root = tree({ "packages/contracts/package.json": pkg("@kerby/schemas") });
    expect(rules(root)).toContain("names:packages/contracts/package.json");
  });

  describe("tenancy", () => {
    const control = (sql: string) =>
      tree({
        "services/control/package.json": pkg("@kerby/control"),
        "services/control/migrations/control/0001.sql": sql,
      });

    it("accepts a control-plane table with tenant_id", () => {
      const root = control(
        "create table api_keys (\n  id uuid primary key,\n  tenant_id uuid not null\n);\n",
      );
      expect(checkArchitecture(root)).toEqual([]);
    });

    it("rejects a control-plane table without tenant_id, and says where tenant data goes", () => {
      const root = control("create table chats (\n  id uuid primary key\n);\n");
      const [violation] = checkArchitecture(root);
      expect(violation?.rule).toBe("tenancy");
      expect(violation?.message).toContain("migrations/tenant/");
    });

    it("accepts a control-plane table that says why it is global", () => {
      const root = control(
        "-- global: the tenant registry itself\ncreate table tenants (\n  id uuid primary key\n);\n",
      );
      expect(checkArchitecture(root)).toEqual([]);
    });

    it("checks every control-plane table in a file, not just the first", () => {
      const root = control(
        "create table a (\n  tenant_id uuid not null\n);\ncreate table b (\n  id uuid primary key\n);\n",
      );
      const violations = checkArchitecture(root);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("table b");
    });

    it("needs no tenant_id in a table that lives in the tenant's own database", () => {
      const root = tree({
        "services/api/migrations/tenant/0001.sql":
          "create table conversations (\n  id uuid primary key\n);\n",
        "packages/durable/package.json": pkg("@kerby/durable"),
        "packages/durable/migrations/tenant/0001_absurd.sql":
          "create table absurd.queues (\n  queue_name text primary key\n);\n",
      });
      expect(checkArchitecture(root)).toEqual([]);
    });

    it("rejects a migration that names neither plane", () => {
      const root = tree({ "services/api/migrations/0001.sql": "select 1;\n" });
      expect(rules(root)).toEqual(["tenancy:services/api/migrations/0001.sql"]);
    });
  });

  describe("providers", () => {
    const api = (deps: Record<string, string>) =>
      pkg("@kerby/api", { "@kerby/contracts": "workspace:*", ...deps });
    const adapter = {
      "packages/runtime-pi-durable/package.json": pkg("@kerby/runtime-pi-durable"),
      "packages/runtime-pi-durable/src/index.ts": "export const x = 1;\n",
    };

    it("rejects a service importing a confined SDK directly", () => {
      const root = tree({
        "services/api/package.json": api({ pg: "catalog:" }),
        "services/api/src/repo/chats.ts": imp("pg") + imp("../types/chat.ts"),
      });
      expect(rules(root)).toEqual(["providers:services/api/src/repo/chats.ts"]);
    });

    it("lets the owning package import its SDK", () => {
      const root = tree({
        "packages/db/package.json": pkg("@kerby/db", { pg: "catalog:" }),
        "packages/db/src/index.ts": imp("pg"),
      });
      expect(checkArchitecture(root)).toEqual([]);
    });

    it("keeps a harness inside its adapter", () => {
      const root = tree({
        "packages/contracts/package.json": pkg("@kerby/contracts", {
          "@earendil-works/pi-durable": "catalog:",
        }),
        "packages/contracts/src/index.ts": imp("@earendil-works/pi-durable"),
      });
      expect(rules(root)).toEqual(["providers:packages/contracts/src/index.ts"]);
    });

    it("lets a service's index.ts wire an adapter and no other file", () => {
      const wired = tree({
        ...adapter,
        "services/api/package.json": api({ "@kerby/runtime-pi-durable": "workspace:*" }),
        "services/api/src/index.ts": imp("./runtime/http.ts") + imp("@kerby/runtime-pi-durable"),
      });
      expect(checkArchitecture(wired)).toEqual([]);

      const buried = tree({
        ...adapter,
        "services/api/package.json": api({ "@kerby/runtime-pi-durable": "workspace:*" }),
        "services/api/src/service/chats.ts":
          imp("../repo/chats.ts") + imp("@kerby/runtime-pi-durable"),
      });
      const [violation] = checkArchitecture(buried);
      expect(violation?.rule).toBe("providers");
      expect(violation?.message).toContain("AgentRuntime");
    });
  });

  describe("config", () => {
    const reads = "export const url = process.env.DATABASE_URL;\n";

    it("rejects reading the process environment outside packages/config and scripts", () => {
      const inService = tree({ "services/api/src/service/chats.ts": reads });
      const [violation] = checkArchitecture(inService);
      expect(violation?.rule).toBe("config");
      expect(violation?.message).toContain("loadConfig");

      const inPackage = tree({ "packages/contracts/src/index.ts": reads });
      expect(rules(inPackage)).toEqual(["config:packages/contracts/src/index.ts"]);

      const imported = tree({
        "packages/contracts/src/index.ts": `import { env } from ${JSON.stringify("node:process")};\n`,
      });
      expect(rules(imported)).toEqual(["config:packages/contracts/src/index.ts"]);
    });

    it("lets packages/config and scripts read it", () => {
      const root = tree({
        "packages/config/package.json": pkg("@kerby/config"),
        "packages/config/src/index.ts": reads,
        "scripts/tool.ts": reads,
      });
      expect(checkArchitecture(root)).toEqual([]);
    });
  });
});
