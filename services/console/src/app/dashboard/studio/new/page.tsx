import type { Metadata } from "next";
import { PageHeader } from "../../../_components/ui.tsx";
import { requireSession } from "../../../_lib/session.ts";
import { Workspace } from "../../_components/panes.tsx";
import { NewPromptForm } from "./form.tsx";

export const metadata: Metadata = { title: "New prompt" };

export default async function NewPromptPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  await requireSession();
  const { kind } = await searchParams;
  return (
    <Workspace>
      <PageHeader
        title="New prompt"
        description="It starts as an empty draft. Its name is how your code asks for it."
      />
      <NewPromptForm kind={kind === "decision" ? "decision" : "chat"} />
    </Workspace>
  );
}
