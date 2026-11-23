import type { Metadata } from "next";
import { PageHeader } from "../../_components/ui.tsx";
import { requireChatAccess } from "../../_lib/session.ts";
import { Workspace } from "../_components/panes.tsx";
import { NewServerForm } from "./server-forms.tsx";

export const metadata: Metadata = { title: "Tools" };

export default async function ToolsPage() {
  await requireChatAccess();
  return (
    <Workspace>
      <PageHeader
        title="Add a tool server"
        description="A remote MCP server whose tools your conversations may call. Nothing is offered until you enable a tool, grant it to an integration that is restricted, and a conversation names it."
      />
      <NewServerForm />
    </Workspace>
  );
}
