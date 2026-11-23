import type { Metadata } from "next";
import { PageHeader } from "../../../_components/ui.tsx";
import { requireSession } from "../../../_lib/session.ts";
import { Workspace } from "../../_components/panes.tsx";
import { NewApiKeyForm } from "./form.tsx";

export const metadata: Metadata = { title: "New API key" };

export default async function NewApiKeyPage() {
  await requireSession();
  return (
    <Workspace>
      <PageHeader
        title="New API key"
        description="Create a key to authenticate calls to the tenant API."
      />
      <NewApiKeyForm />
    </Workspace>
  );
}
