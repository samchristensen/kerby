// Doc freshness, the mechanical part. `make docs` runs it on every git-tracked *.md file; CI gates on it.
// It fails when a doc
//   - links (`[text](path)`, `![alt](path)`, `[ref]: path`) to a relative path that does not exist,
//   - names a make target (an inline code span starting `make <target>`) the Makefile does not define,
//   - says a rule is enforced by naming it (rule `x`) and scripts/check-architecture.ts has no rule `x`.
// Limits, on purpose: Markdown is read with regexes, line by line. Fenced code blocks (``` or ~~~) are skipped;
// inline code spans are not searched for links. Links that wrap across lines, angle-bracket targets (`<path>`),
// HTML tags, and whether a `#anchor` names a real heading are not checked; external links (any `scheme:`) are not
// fetched. Make targets are read from rule lines of the Makefile (`name:`), so pattern rules and targets made by
// include files are unknown. Whether an ADR's decision still matches the code is a person's (or agent's) job at
// each milestone close.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RULES } from "./check-architecture.ts";

export type DocProblem = {
  kind: "link" | "make" | "rule";
  file: string;
  line: number;
  message: string;
};

/** Targets defined by rule lines (`a b: deps`), not variable assignments (`X := y`). */
export function makeTargets(makefile: string): Set<string> {
  const targets = new Set<string>();
  for (const line of makefile.split("\n")) {
    const match = /^([A-Za-z0-9_.-][A-Za-z0-9_. -]*?)\s*::?(?!=)/.exec(line);
    if (!match?.[1]) continue;
    for (const name of match[1].split(/\s+/)) if (!name.startsWith(".")) targets.add(name);
  }
  return targets;
}

const LINK = /!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const REF_LINK = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/;
const CODE_SPAN = /`([^`]+)`/g;
const RULE = /\brule `([^`]+)`/gi;

/** Checks `docs` (paths relative to `root`) against the tree, Makefile, and architecture rules at `root`. */
export function checkDocs(
  root: string,
  docs: readonly string[],
  rules: readonly string[] = RULES,
): DocProblem[] {
  const problems: DocProblem[] = [];
  const makefile = join(root, "Makefile");
  const targets = makeTargets(existsSync(makefile) ? readFileSync(makefile, "utf8") : "");

  for (const doc of docs) {
    const lines = readFileSync(join(root, doc), "utf8").split("\n");
    let fence: string | undefined;
    lines.forEach((text, i) => {
      const line = i + 1;
      const add = (kind: DocProblem["kind"], message: string) =>
        problems.push({ kind, file: doc, line, message });

      const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(text)?.[1];
      if (fence !== undefined) {
        if (opener && opener[0] === fence[0] && opener.length >= fence.length) fence = undefined;
        return;
      }
      if (opener) {
        fence = opener;
        return;
      }

      const prose = text.replace(CODE_SPAN, "``");
      const targetsHere = [...prose.matchAll(LINK)].map((m) => m[1] ?? "");
      const ref = REF_LINK.exec(prose)?.[1];
      if (ref) targetsHere.push(ref);
      for (const target of targetsHere) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
        const path = decodeURI(target.replace(/[#?].*$/, ""));
        const abs = path.startsWith("/") ? join(root, path) : resolve(root, dirname(doc), path);
        if (!existsSync(abs)) {
          add(
            "link",
            `link target "${target}" does not exist (resolved relative to ${dirname(doc)}/). Fix: point the link at the file's current path, or remove the link if the file is gone.`,
          );
        }
      }

      for (const [, span = ""] of text.matchAll(CODE_SPAN)) {
        const words = /^make\s+(.*)$/.exec(span.trim())?.[1]?.split(/\s+/) ?? [];
        const first = words.find((w) => !w.includes("=") && !w.startsWith("-"));
        for (const name of first?.split("|") ?? []) {
          if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || targets.has(name)) continue;
          add(
            "make",
            `\`make ${name}\` is not a Makefile target. Fix: use an existing target (\`make help\` lists them) or add "${name}:" with a "## description" to the Makefile.`,
          );
        }
      }

      for (const [, id = ""] of text.matchAll(RULE)) {
        if (rules.includes(id)) continue;
        add(
          "rule",
          `rule \`${id}\` is not a rule in scripts/check-architecture.ts (rules: ${rules.join(", ")}). Fix: name the rule that enforces this, add the rule to the check, or mark the line _review_ if nothing enforces it.`,
        );
      }
    });
  }
  return problems;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? process.cwd());
  const docs = execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const problems = checkDocs(root, docs);
  for (const p of problems) console.error(`${p.file}:${p.line}: [${p.kind}] ${p.message}\n`);
  if (problems.length > 0) {
    console.error(`${problems.length} doc problem(s). Fix the doc: a stale doc is a bug.`);
    process.exit(1);
  }
  console.log(`docs: ok (${docs.length} files)`);
}
