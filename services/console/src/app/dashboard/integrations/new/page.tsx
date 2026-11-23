import type { Metadata } from "next";
import { PageHeader } from "../../../_components/ui.tsx";
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
        description="A named client of your workspace. Create its keys on its page."
      />
      <NewIntegrationForm />
    </Workspace>
  );
}
