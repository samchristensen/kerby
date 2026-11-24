import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDocs, makeTargets } from "./check-docs.ts";

const FENCE = "`".repeat(3);
const BASE: Record<string, string> = {
  Makefile:
    "SHELL := /bin/bash\n.PHONY: check up\ncheck: lint ## gate\n\tpnpm x\nup down: ## stack\n\ttrue\n",
  "ARCHITECTURE.md": "# Architecture\n",
  "docs/README.md": "# Docs\n",
  "docs/adr/0001-x.md": "# ADR\n",
};
const RULES = ["config", "docker"];

const roots: string[] = [];
/** A temp tree with BASE plus `files`; returns the root and every .md path in it. */
function tree(files: Record<string, string>): { root: string; docs: string[] } {
  const root = mkdtempSync(join(tmpdir(), "kerby-docs-"));
  roots.push(root);
  const all = { ...BASE, ...files };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return { root, docs: Object.keys(all).filter((p) => p.endsWith(".md")) };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const problems = (doc: string) => {
  const { root, docs } = tree({ "docs/guide.md": doc });
  return checkDocs(root, docs, RULES).map((p) => `${p.kind}:${p.file}:${p.line}`);
};

describe("checkDocs", () => {
  it("accepts links that resolve, with anchors, to files and directories, up and down the tree", () => {
    expect(
      problems(
        [
          "See [the index](README.md), [adr](adr/), [arch](../ARCHITECTURE.md#layers),",
          '![img](./adr/0001-x.md "title") and [abs](/docs/README.md).',
          "[ref]: adr/0001-x.md",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("rejects a link or image to a missing file, naming file and line", () => {
    expect(problems("# Guide\n\n[gone](old.md#x) and ![pic](img.png)\n[r]: nope/")).toEqual([
      "link:docs/guide.md:3",
      "link:docs/guide.md:3",
      "link:docs/guide.md:4",
    ]);
  });

  it("says how to fix a broken link", () => {
    const { root, docs } = tree({ "docs/guide.md": "[gone](old.md)\n" });
    const [p] = checkDocs(root, docs, RULES);
    expect(p?.message).toContain('"old.md" does not exist');
    expect(p?.message).toContain("Fix:");
  });

  it("leaves history alone: a finished plan and a superseded ADR, but not an ADR that is only amended", () => {
    const stale = "Run `make deploy`, see [the script](../../scripts/gone.ts).\n";
    const { root, docs } = tree({
      "docs/plans/done/0001-old.md": stale,
      "docs/adr/0002-old.md": `# 0002\n\n- Status: superseded by 0003\n\n${stale}`,
      "docs/adr/0003-live.md": `# 0003\n\n- Status: accepted, amended by 0004\n\n${stale}`,
    });
    expect(checkDocs(root, docs, RULES).map((p) => `${p.kind}:${p.file}`)).toEqual([
      "link:docs/adr/0003-live.md",
      "make:docs/adr/0003-live.md",
    ]);
  });

  it("ignores external links, pure anchors, inline code, and fenced code", () => {
    const doc = [
      "[site](https://example.com/x.md) [plain](http://x) [mail](mailto:a@b.c) [top](#guide)",
      "`[not a link](missing.md)`",
      `${FENCE}md`,
      "[in a fence](missing.md) `make nope` rule `nope`",
      FENCE,
      "~~~",
      "[tilde fence](missing.md)",
      "~~~",
    ].join("\n");
    expect(problems(doc)).toEqual([]);
  });

  it("accepts make targets the Makefile defines, with variables, alternatives, and placeholders", () => {
    expect(
      problems(
        "`make check`, `make up|down`, `make ENV=x up`, `make down V=1`, `make <target>`, `make`",
      ),
    ).toEqual([]);
  });

  it("rejects a make target the Makefile does not define", () => {
    const { root, docs } = tree({ "docs/guide.md": "ok\nrun `make knip` then `make up|lint`\n" });
    const found = checkDocs(root, docs, RULES);
    expect(found.map((p) => `${p.kind}:${p.line}`)).toEqual(["make:2", "make:2"]);
    expect(found[0]?.message).toContain("`make knip` is not a Makefile target");
    expect(found[1]?.message).toContain("`make lint`");
  });

  it("accepts rules the architecture check has and rejects others", () => {
    expect(
      problems("Enforced (rule `config`).\nenforced, rule `docker`.\nEnforced (rule `secrets`)."),
    ).toEqual(["rule:docs/guide.md:3"]);
  });

  it("names the known rules when one is unknown", () => {
    const { root, docs } = tree({ "docs/guide.md": "Enforced (Rule `nope`)." });
    expect(checkDocs(root, docs, RULES)[0]?.message).toContain("rules: config, docker");
  });
});

describe("makeTargets", () => {
  it("reads rule lines, not assignments or special targets", () => {
    expect([...makeTargets(BASE.Makefile ?? "")].sort()).toEqual(["check", "down", "up"]);
  });
});
