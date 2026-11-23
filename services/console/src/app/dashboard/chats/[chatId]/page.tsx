import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { consoleService } from "../../../_lib/console.ts";
import { requireChatAccess } from "../../../_lib/session.ts";
import { ChatThread } from "./thread.tsx";

export const metadata: Metadata = { title: "Chat" };

export default async function ChatPage({ params }: { params: Promise<{ chatId: string }> }) {
  const access = await requireChatAccess();
  const { chatId } = await params;
  const chat = await consoleService().chat(access, chatId);
  if (!chat) notFound();
  // Keyed, so moving from one conversation to another starts its state afresh.
  return <ChatThread key={chat.id} chat={chat} />;
}
