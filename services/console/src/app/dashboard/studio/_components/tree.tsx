"use client";
// The Studio's list pane: prompts and decision models in two tabs, each a tree of their names split at `/`.
import type { PromptKind, PromptSummary } from "@kerby/contracts";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { NavLink } from "../../../_components/client.tsx";
import { Badge } from "../../../_components/ui.tsx";
import { listItemActiveClass } from "../../_components/panes.tsx";

const PROMPTS_PATH = "/dashboard/studio/prompts/";

/** A folder (a name's leading segments) or a prompt; a name can be both (`support` and `support/triage`). */
type TreeNode = { segment: string; prompt?: PromptSummary; children: TreeNode[] };

function buildTree(prompts: PromptSummary[]): TreeNode[] {
  const root: TreeNode = { segment: "", children: [] };
  for (const prompt of prompts) {
    let node = root;
    for (const segment of prompt.name.split("/")) {
      let child = node.children.find((c) => c.segment === segment);
      if (!child) {
        child = { segment, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.prompt = prompt;
  }
  return root.children;
}

function PromptBadges({ prompt }: { prompt: PromptSummary }) {
  return (
    <span className="flex shrink-0 flex-wrap justify-end gap-1">
      {prompt.latestVersion === null ? (
        <Badge tone="neutral">draft</Badge>
      ) : (
        <Badge tone="live">v{prompt.latestVersion}</Badge>
      )}
      {Object.entries(prompt.labels).map(([label, version]) => (
        <Badge key={label} tone="brand">
          {label}·v{version}
        </Badge>
      ))}
    </span>
  );
}

function Nodes({ nodes, depth }: { nodes: TreeNode[]; depth: number }) {
  return (
    <ul>
      {nodes.map((node) => (
        <li key={node.segment}>
          {node.prompt ? (
            <NavLink
              href={`${PROMPTS_PATH}${node.prompt.name}`}
              exact
              className="flex items-center justify-between gap-2 border-b border-line py-2 pr-3 text-sm hover:bg-raised"
              activeClassName={listItemActiveClass}
            >
              <span
                className="truncate font-medium text-fg"
                style={{ paddingLeft: 16 + depth * 14 }}
              >
                {node.segment}
              </span>
              <PromptBadges prompt={node.prompt} />
            </NavLink>
          ) : (
            <p
              className="border-b border-line py-2 pr-3 text-sm text-muted"
              style={{ paddingLeft: 16 + depth * 14 }}
            >
              {node.segment}/
            </p>
          )}
          {node.children.length > 0 ? <Nodes nodes={node.children} depth={depth + 1} /> : null}
        </li>
      ))}
    </ul>
  );
}

const TABS: { kind: PromptKind; label: string }[] = [
  { kind: "chat", label: "Prompts" },
  { kind: "decision", label: "Decision models" },
];

export function StudioTree({ prompts }: { prompts: PromptSummary[] }) {
  const pathname = usePathname();
  const open = pathname.startsWith(PROMPTS_PATH)
    ? prompts.find((p) => pathname === `${PROMPTS_PATH}${p.name}`)
    : undefined;
  const [chosen, setChosen] = useState<PromptKind | undefined>();
  // The open prompt's tab, until the person picks one.
  const kind = chosen ?? open?.kind ?? "chat";
  const shown = prompts.filter((p) => p.kind === kind);
  return (
    <>
      <div role="tablist" className="flex gap-1 border-b border-line px-3 py-2">
        {TABS.map((tab) => (
          <button
            key={tab.kind}
            type="button"
            role="tab"
            aria-selected={kind === tab.kind}
            onClick={() => setChosen(tab.kind)}
            className={`rounded-md px-2.5 py-1 text-sm font-medium ${
              kind === tab.kind ? "bg-brand/10 text-brand-text" : "text-muted hover:bg-raised"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">
          {kind === "chat" ? "No prompts yet." : "No decision models yet."} Create one with New.
        </p>
      ) : (
        <Nodes nodes={buildTree(shown)} depth={0} />
      )}
    </>
  );
}
