// `make sdk-build` and `make sdk-publish`: build `@kerby/sdk` into packages/sdk/dist, and publish that to its own
// (private) GitHub repository, where customers' projects install it from a git tag.
//
//   node scripts/sdk.ts build              compile, rewrite specifiers, write the publishable package.json
//   node scripts/sdk.ts publish [--dry-run] build, then commit dist and the docs to the SDK repo, tag v<version>, push
//
// Why a separate repository: the monorepo has no build step and its packages are `workspace:*` (nothing in it installs
// from git). The SDK repo holds only what a consumer runs: compiled JS and .d.ts of the SDK and of the contracts it
// is made from (so types and schemas cannot drift from the API), plus the integration guide.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdkDir = join(root, "packages", "sdk");
const dist = join(sdkDir, "dist");
/** tsc's output: the package's code. The rest of dist/ is what the SDK repo's root holds beside it. */
const lib = join(dist, "lib");
/** Entry of each `@kerby/*` specifier the sources use, relative to lib. */
const ENTRIES: Record<string, string> = {
  "@kerby/contracts/tenant": "contracts/src/tenant.js",
  "@kerby/agent": "agent/src/index.js",
  "@kerby/judgment": "judgment/src/index.js",
};
/** What the SDK repo's root holds besides dist/: the guide an agent reads first. */
const DOCS = ["README.md", "INTEGRATION.md"];
const DEFAULT_REPO = "git@github.com:samchristensen/kerby-sdk.git";

const run = (command: string, args: string[], cwd = root): string =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

/** The string at `path` in parsed JSON or YAML; throws naming the path when it is not one. */
function stringAt(document: unknown, ...path: string[]): string {
  let value = document;
  for (const key of path) {
    value =
      typeof value === "object" && value !== null && key in value
        ? Reflect.get(value, key)
        : undefined;
  }
  if (typeof value !== "string") throw new Error(`expected a string at ${path.join(".")}`);
  return value;
}

function build(): { version: string } {
  rmSync(dist, { recursive: true, force: true });
  run("pnpm", ["exec", "tsc", "-p", join(sdkDir, "tsconfig.build.json")]);

  // `@kerby/*` -> a relative path inside dist: after this the tree imports nothing but zod.
  const unresolved: string[] = [];
  for (const file of files(lib)) {
    if (!file.endsWith(".js") && !file.endsWith(".d.ts")) continue;
    const source = readFileSync(file, "utf8");
    const rewritten = source.replace(
      /(\bfrom\s*|\bimport\s*\(\s*)(["'])(@kerby\/[\w/-]+)\2/g,
      (match, lead: string, quote: string, specifier: string) => {
        const entry = ENTRIES[specifier];
        if (!entry) {
          unresolved.push(`${relative(lib, file)}: ${specifier}`);
          return match;
        }
        const path = relative(dirname(file), join(lib, entry)).split("\\").join("/");
        return `${lead}${quote}${path.startsWith(".") ? path : `./${path}`}${quote}`;
      },
    );
    if (rewritten !== source) writeFileSync(file, rewritten);
  }
  if (unresolved.length > 0)
    throw new Error(
      `the SDK imports a @kerby package the build does not carry:\n  ${unresolved.join("\n  ")}\nFix: add it to ENTRIES in scripts/sdk.ts and to paths in packages/sdk/tsconfig.build.json.`,
    );

  const version = stringAt(
    JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")),
    "version",
  );
  const zod = stringAt(
    parse(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")),
    "catalog",
    "zod",
  );
  const entry = "./lib/sdk/src/index";
  const manifest = {
    name: "@kerby/sdk",
    version,
    description: "Typed client and contracts for the Kerby API",
    type: "module",
    sideEffects: false,
    engines: { node: ">=22" },
    exports: { ".": { types: `${entry}.d.ts`, default: `${entry}.js` } },
    types: `${entry}.d.ts`,
    files: ["lib", ...DOCS, "AGENTS.md", "CLAUDE.md"],
    dependencies: { zod: `^${zod}` },
  };
  writeFileSync(join(dist, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const doc of DOCS) cpSync(join(sdkDir, doc), join(dist, doc));
  cpSync(join(sdkDir, "publish"), dist, { recursive: true });
  console.log(`built @kerby/sdk ${version} in ${relative(root, dist)}`);
  return { version };
}

function publish(dryRun: boolean): void {
  if (run("git", ["status", "--porcelain"]).trim() !== "")
    throw new Error(
      "the working tree has uncommitted changes. Fix: commit them first; the SDK is published from a commit, and its message names the commit.",
    );
  const commit = run("git", ["rev-parse", "--short", "HEAD"]).trim();
  const { version } = build();
  const tag = `v${version}`;
  const repo = process.env.KERBY_SDK_REPO ?? DEFAULT_REPO;

  const work = mkdtempSync(join(tmpdir(), "kerby-sdk-"));
  try {
    const checkout = join(work, "repo");
    run("git", ["clone", repo, checkout]);
    // Replace the tree: a file deleted from dist/ must disappear from the repository.
    for (const name of readdirSync(checkout)) {
      if (name !== ".git") rmSync(join(checkout, name), { recursive: true, force: true });
    }
    cpSync(dist, checkout, { recursive: true });
    run("git", ["add", "-A"], checkout);
    if (run("git", ["status", "--porcelain"], checkout).trim() === "") {
      console.log("the SDK repository already has exactly this build; nothing to publish");
      return;
    }
    if (run("git", ["tag", "--list", tag], checkout).trim() !== "")
      throw new Error(
        `${tag} is already published with different contents. Fix: raise "version" in packages/sdk/package.json (consumers pin a tag, so a tag never moves).`,
      );
    run("git", ["commit", "-m", `@kerby/sdk ${version} from kerby ${commit}`], checkout);
    run("git", ["tag", tag], checkout);
    if (dryRun) {
      console.log(`dry run: committed ${tag} in ${checkout}; not pushed`);
      return;
    }
    run("git", ["push", "origin", "HEAD:refs/heads/main", `refs/tags/${tag}`], checkout);
    console.log(`published ${tag} to ${repo}`);
    console.log(`install: pnpm add github:samchristensen/kerby-sdk#${tag}`);
  } finally {
    if (!dryRun) rmSync(work, { recursive: true, force: true });
  }
}

const [command, flag] = process.argv.slice(2);
if (command === "build") build();
else if (command === "publish") publish(flag === "--dry-run");
else {
  console.error("usage: node scripts/sdk.ts build | publish [--dry-run]");
  process.exit(1);
}
