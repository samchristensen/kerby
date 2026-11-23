import type { Metadata } from "next";
import { PageHeader } from "../../../_components/ui.tsx";
import { consoleService } from "../../../_lib/console.ts";
import { requireSession } from "../../../_lib/session.ts";
import { Workspace } from "../../_components/panes.tsx";
import { NewChatForm } from "./form.tsx";

export const metadata: Metadata = { title: "New chat" };

export default async function NewChatPage() {
  const session = await requireSession();
  const providers = (await consoleService().providers(session))
    .filter((provider) => provider.configured && provider.chat)
    .map((provider) => provider.id);
  return (
    <Workspace>
      <PageHeader title="New chat" description="Start a conversation with your agent." />
      <NewChatForm providers={providers} />
    </Workspace>
  );
}
