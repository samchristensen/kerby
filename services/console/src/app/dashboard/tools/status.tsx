// How a tool server's state reads, in the list and on its page. Server-safe.
import type { ToolServerSummary } from "@kerby/contracts";
import { Badge } from "../../_components/ui.tsx";

export function ServerStatus({ status, kind }: Pick<ToolServerSummary, "status" | "kind">) {
  if (kind === "builtin") return <Badge tone="brand">Built in</Badge>;
  if (status === "ready") return <Badge tone="live">Ready</Badge>;
  if (status === "error") return <Badge tone="danger">Error</Badge>;
  return <Badge tone="neutral">Listing tools…</Badge>;
}

/** "12 tools · 3 enabled · 1 drifted" */
export function toolCounts(
  server: Pick<ToolServerSummary, "toolCount" | "enabledCount" | "driftedCount">,
): string {
  const parts = [
    server.toolCount === 1 ? "1 tool" : `${server.toolCount} tools`,
    `${server.enabledCount} enabled`,
  ];
  if (server.driftedCount > 0) parts.push(`${server.driftedCount} drifted`);
  return parts.join(" · ");
}
