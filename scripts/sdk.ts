// `make sdk-build` and `make sdk-publish`: build the SDK into packages/sdk/dist, and publish that to the npm
// registry, where applications install it.
//
//   node scripts/sdk.ts build              compile, rewrite specifiers, write the publishable package.json
//   node scripts/sdk.ts publish [--dry-run] build, and `npm publish` it as the next patch if it differs from the latest
//
// Why a build at all: the monorepo has no build step and its packages are `workspace:*` (nothing in it installs from a
// registry). The published package holds only what a consumer runs: compiled JS and .d.ts of the SDK and of the contracts
// it is made from (so types and schemas cannot drift from the API), plus the integration guide. CI runs `publish` on every
// merge to main (ADR 0025) with npm trusted publishing: no token exists to leak, and npm records where each version was built.
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
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
/** tsc's output: the package's code. The rest of dist/ is the docs and manifest that sit beside it in the package. */
const lib = join(dist, "lib");
/** Entry of each `@kerby/*` specifier the sources use, relative to lib. */
const ENTRIES: Record<string, string> = {
  "@kerby/contracts/tenant": "contracts/src/tenant.js",
  "@kerby/agent": "agent/src/index.js",
  "@kerby/judgment": "judgment/src/index.js",
};
/** What the package holds besides lib/: the guide an agent reads first. */
const DOCS = ["README.md", "INTEGRATION.md"];
const NAME = "@samchristensen/kerby-sdk";
const REPO = "https://github.com/samchristensen/kerby";

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

/** The release line from packages/sdk/package.json: its `version` is `<major>.<minor>.0` and patches are numbered by `publish`. */
function line(): string {
  const [major, minor] = stringAt(
    JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")),
    "version",
  ).split(".");
  return `${major}.${minor}`;
}

function build(version: string): void {
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

  // `version` is `<major>.<minor>.<patch>`; see `line()` and `publish`.
  const zod = stringAt(
    parse(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")),
    "catalog",
    "zod",
  );
  const entry = "./lib/sdk/src/index";
  const manifest = {
    name: NAME,
    version,
    description: "Typed client and contracts for the Kerby API",
    license: "MIT",
    type: "module",
    sideEffects: false,
    engines: { node: ">=22" },
    exports: { ".": { types: `${entry}.d.ts`, default: `${entry}.js` } },
    types: `${entry}.d.ts`,
    files: ["lib", ...DOCS, "AGENTS.md", "CLAUDE.md", "LICENSE"],
    dependencies: { zod: `^${zod}` },
    repository: { type: "git", url: `git+${REPO}.git`, directory: "packages/sdk" },
    homepage: `${REPO}/tree/main/packages/sdk#readme`,
    bugs: { url: `${REPO}/issues` },
    publishConfig: { access: "public" },
  };
  writeFileSync(join(dist, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const doc of DOCS) cpSync(join(sdkDir, doc), join(dist, doc));
  cpSync(join(root, "LICENSE"), join(dist, "LICENSE"));
  cpSync(join(sdkDir, "publish"), dist, { recursive: true });
  console.log(`built ${NAME} ${version} in ${relative(root, dist)}`);
}

/** The patch numbers the registry holds on the `<minor>` line; none when the package was never published. */
function publishedPatches(minor: string): number[] {
  const result = spawnSync("npm", ["view", NAME, "versions", "--json"], { encoding: "utf8" });
  if (result.status !== 0) {
    if (result.stderr.includes("E404")) return [];
    throw new Error(`npm view ${NAME} failed:\n${result.stderr}`);
  }
  const parsed: unknown = JSON.parse(result.stdout);
  const versions = typeof parsed === "string" ? [parsed] : parsed;
  if (!Array.isArray(versions) || !versions.every((v): v is string => typeof v === "string"))
    throw new Error(`npm view ${NAME} versions: expected a list of version strings`);
  return versions
    .filter((v) => v.startsWith(`${minor}.`))
    .map((v) => Number(v.slice(minor.length + 1)))
    .filter(Number.isInteger);
}

/** `npm pack <spec>` unpacked under `into`: the files a consumer would get, by path. */
function unpacked(spec: string, into: string): Map<string, Buffer> {
  mkdirSync(into, { recursive: true });
  const packed = run("npm", ["pack", spec, "--json", "--pack-destination", into]);
  run("tar", ["-xzf", join(into, stringAt(JSON.parse(packed), "0", "filename")), "-C", into]);
  const contents = new Map<string, Buffer>();
  for (const file of files(join(into, "package"))) {
    contents.set(relative(join(into, "package"), file), readFileSync(file));
  }
  return contents;
}

/** Whether the package just built (in dist/) is byte for byte what the registry holds as `version`. */
function sameAsPublished(version: string): boolean {
  const work = mkdtempSync(join(tmpdir(), "kerby-sdk-"));
  try {
    const mine = unpacked(dist, join(work, "mine"));
    const theirs = unpacked(`${NAME}@${version}`, join(work, "theirs"));
    return (
      mine.size === theirs.size &&
      [...mine].every(([path, bytes]) => theirs.get(path)?.equals(bytes) === true)
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function publish(dryRun: boolean): void {
  if (run("git", ["status", "--porcelain"]).trim() !== "")
    throw new Error(
      "the working tree has uncommitted changes. Fix: commit them first; the SDK is published from a commit.",
    );
  const minor = line();
  // The patch number is the next free one on this line (0.1.0, 0.1.1, ...): nobody bumps it by hand.
  const patches = publishedPatches(minor);
  const latest = patches.length > 0 ? Math.max(...patches) : undefined;

  let version = `${minor}.0`;
  if (latest !== undefined) {
    // Build as the latest version: no difference means nothing changed since it, and nothing is published.
    build(`${minor}.${latest}`);
    if (sameAsPublished(`${minor}.${latest}`)) {
      console.log(`${NAME} ${minor}.${latest} is already exactly this build; nothing to publish`);
      return;
    }
    version = `${minor}.${latest + 1}`;
  }
  build(version);
  // Provenance is recorded only where npm can prove the build (a GitHub-hosted runner with trusted publishing).
  const args = [
    "publish",
    dist,
    ...(dryRun ? ["--dry-run"] : []),
    ...(process.env.GITHUB_ACTIONS ? ["--provenance"] : []),
  ];
  console.log(run("npm", args));
  console.log(`${dryRun ? "dry run: would publish" : "published"} ${NAME}@${version}`);
}

const [command, flag] = process.argv.slice(2);
if (command === "build") build(`${line()}.0`);
else if (command === "publish") publish(flag === "--dry-run");
else {
  console.error("usage: node scripts/sdk.ts build | publish [--dry-run]");
  process.exit(1);
}
