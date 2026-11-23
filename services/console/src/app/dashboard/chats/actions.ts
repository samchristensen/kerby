"use server";
import { redirect } from "next/navigation";
import type { ChatListView, ChatStatus, FormFailure } from "../../../types/index.ts";
import { consoleService } from "../../_lib/console.ts";
import { requireChatAccess } from "../../_lib/session.ts";

/** A refused form also returns what was typed: React clears an uncontrolled form once its action completes. */
export type CreateChatState = (FormFailure & { values: Record<string, string> }) | undefined;

/** Start a conversation with its first message, then open it. */
export async function createChatAction(
  _previous: CreateChatState,
  formData: FormData,
): Promise<CreateChatState> {
  const access = await requireChatAccess();
  const form = Object.fromEntries(formData);
  const result = await consoleService().createChat(access, form);
  if (!result.ok) {
    const values = Object.fromEntries(
      ["model", "system", "message"].map((name) => [name, String(form[name] ?? "")]),
    );
    return { ...result, values };
  }
  redirect(`/dashboard/chats/${result.id}`);
}

export type SendResult = { ok: true } | FormFailure;

/** Post a message. Its persisted copy and the answer reach the page on the event stream, not here. */
export async function sendMessageAction(chatId: string, message: string): Promise<SendResult> {
  const access = await requireChatAccess();
  const result = await consoleService().sendMessage(access, chatId, { message });
  return result.ok ? { ok: true } : result;
}

/** A page of the conversation list: the newest, or the one after `cursor`. */
export async function listChatsAction(cursor?: string): Promise<ChatListView> {
  return consoleService().chats(await requireChatAccess(), cursor);
}

/** Whether a turn is still running: the page's backstop for a live event it missed. */
export async function chatStatusAction(chatId: string): Promise<ChatStatus | undefined> {
  return consoleService().chatStatus(await requireChatAccess(), chatId);
}
