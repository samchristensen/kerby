import type { Metadata } from "next";
import { PageHeader } from "../../../_components/ui.tsx";
import { consoleService } from "../../../_lib/console.ts";
import { requireChatAccess } from "../../../_lib/session.ts";
import { Workspace } from "../../_components/panes.tsx";
import { NewChatForm } from "./form.tsx";

export const metadata: Metadata = { title: "New chat" };

export default async function NewChatPage() {
  const access = await requireChatAccess();
  const service = consoleService();
  const [providers, prompts, tools] = await Promise.all([
    service.providers(access.session),
    service.prompts(access, "chat"),
    service.availableTools(access),
  ]);
  return (
    <Workspace>
      <PageHeader title="New chat" description="Start a conversation with your agent." />
      <NewChatForm
        providers={providers.filter((p) => p.configured && p.chat).map((p) => p.id)}
        // Only a published prompt can start a chat: a draft is tried in the Studio's playground.
        prompts={prompts.filter((p) => p.latestVersion !== null)}
        tools={tools}
      />
    </Workspace>
  );
}
