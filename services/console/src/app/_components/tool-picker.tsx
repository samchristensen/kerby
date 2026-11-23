"use client";
// Choosing tools by pattern (ADR 0019), grouped by server: a whole server (`<server>/*`, every tool it enables, as it is
// at each turn) or single tools (`<server>/<tool>`). In a form each checked pattern is a field `tool:<pattern>`.
import type { AvailableTool } from "@kerby/contracts";
import { useState } from "react";

type Choice = Pick<AvailableTool, "pattern" | "title" | "description" | "effect">;

const slugOf = (pattern: string) => pattern.slice(0, pattern.indexOf("/"));

export function ToolPicker({
  available,
  servers = [],
  selected,
  onChange,
}: {
  /** The single tools on offer. */
  available: Choice[];
  /** Servers to offer whole even when none of their tools is on offer now. */
  servers?: string[];
  /** Checked at first. A pattern not on offer stays listed (and checked) so saving does not drop it silently. */
  selected: string[];
  onChange?: (patterns: string[]) => void;
}) {
  const [checked, setChecked] = useState(() => new Set(selected));
  const offered = new Set(available.map((tool) => tool.pattern));
  const extra: Choice[] = selected
    .filter((pattern) => !pattern.endsWith("/*") && !offered.has(pattern))
    .map((pattern) => ({ pattern, title: null, description: "", effect: "write" }));
  const choices = [...available, ...extra];
  const slugs = [
    ...new Set([
      ...choices.map((tool) => slugOf(tool.pattern)),
      ...servers,
      ...selected.map(slugOf),
    ]),
  ];

  const toggle = (pattern: string, on: boolean) => {
    const next = new Set(checked);
    if (on) next.add(pattern);
    else next.delete(pattern);
    setChecked(next);
    onChange?.([...next]);
  };

  if (slugs.length === 0) {
    return (
      <p className="text-sm text-zinc-500">
        No tools are enabled yet. Add a server and enable its tools under Tools.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {slugs.map((slug) => {
        const whole = `${slug}/*`;
        const wholeChecked = checked.has(whole);
        return (
          <fieldset key={slug} className="rounded-lg border border-zinc-200 p-3">
            <legend className="px-1 font-mono text-sm font-medium text-zinc-900">{slug}</legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name={`tool:${whole}`}
                checked={wholeChecked}
                onChange={(event) => toggle(whole, event.target.checked)}
                className="mt-1"
              />
              <span>
                <span className="font-medium text-zinc-900">Every tool of {slug}</span>
                <span className="block text-zinc-500">
                  Whatever it enables at each turn, tools enabled later included.
                </span>
              </span>
            </label>
            <ul className="mt-2 space-y-1.5 border-t border-zinc-100 pt-2">
              {choices
                .filter((tool) => slugOf(tool.pattern) === slug)
                .map((tool) => (
                  <li key={tool.pattern}>
                    <label
                      className={`flex items-start gap-2 text-sm ${wholeChecked ? "opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        name={`tool:${tool.pattern}`}
                        checked={wholeChecked || checked.has(tool.pattern)}
                        disabled={wholeChecked}
                        onChange={(event) => toggle(tool.pattern, event.target.checked)}
                        className="mt-1"
                      />
                      <span className="min-w-0">
                        <code className="font-mono text-zinc-900">{tool.pattern}</code>
                        {offered.has(tool.pattern) ? (
                          <span className="ml-2 text-xs text-zinc-500">{tool.effect}</span>
                        ) : (
                          <span className="ml-2 text-xs text-amber-700">not enabled now</span>
                        )}
                        {tool.title || tool.description ? (
                          <span className="block truncate text-zinc-500">
                            {tool.title ?? tool.description}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                ))}
            </ul>
          </fieldset>
        );
      })}
    </div>
  );
}
