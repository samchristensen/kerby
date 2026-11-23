import type { ReactNode } from "react";
import { ButtonLink } from "../../_components/ui.tsx";
import { consoleService } from "../../_lib/console.ts";
import { requireChatAccess } from "../../_lib/session.ts";
import { ListPane, SectionShell } from "../_components/panes.tsx";
import { ChatList } from "./chat-list.tsx";

export default async function ChatsLayout({ children }: { children: ReactNode }) {
  const access = await requireChatAccess();
  const initial = await consoleService().chats(access);
  const list = (
    <ListPane title="Chats" actions={<ButtonLink href="/dashboard/chats/new">New chat</ButtonLink>}>
      <ChatList initial={initial} />
    </ListPane>
  );
  return <SectionShell list={list}>{children}</SectionShell>;
}
