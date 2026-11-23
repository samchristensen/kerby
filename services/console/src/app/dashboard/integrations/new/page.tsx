import type { Metadata } from "next";
import { PageHeader } from "../../../_components/ui.tsx";
import { consoleService } from "../../../_lib/console.ts";
import { requireSession } from "../../../_lib/session.ts";
import { Workspace } from "../../_components/panes.tsx";
import { NewIntegrationForm } from "./form.tsx";

export const metadata: Metadata = { title: "New integration" };

export default async function NewIntegrationPage() {
  await requireSession();
  return (
    <Workspace>
      <PageHeader
        title="New integration"
        description="One system that calls Kerby. Give it only the scopes it needs; you add its keys next."
      />
      <NewIntegrationForm scopes={consoleService().scopeOptions()} />
    </Workspace>
  );
}
