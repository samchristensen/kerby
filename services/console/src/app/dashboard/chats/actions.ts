"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type {
  ChatListView,
  ChatSearchView,
  ChatStatus,
  FormFailure,
} from "../../../types/index.ts";
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
    // Every field, the prompt's `var.<name>` ones too: they are given back to the form as typed.
    const values = Object.fromEntries(
      Object.entries(form).map(([name, value]) => [name, typeof value === "string" ? value : ""]),
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

export type SearchChatsState = { ok: true; result: ChatSearchView } | FormFailure;

/** Search the tenant's chats. An action, not a `?q=` page: the query stays out of every URL and request log. */
export async function searchChatsAction(query: string): Promise<SearchChatsState> {
  return consoleService().searchChats(await requireChatAccess(), { query });
}

export type EmbeddingModelState =
  | { ok: true; embeddingModel: string | null }
  | FormFailure
  | undefined;

/** Set the embedding model (form field `embeddingModel`), or clear it with a blank one. */
export async function setEmbeddingModelAction(
  _previous: EmbeddingModelState,
  formData: FormData,
): Promise<EmbeddingModelState> {
  const access = await requireChatAccess();
  const result = await consoleService().setEmbeddingModel(access, Object.fromEntries(formData));
  revalidatePath("/dashboard/chats/search-settings");
  return result;
}

/** Turn semantic search off; the keyword index stays. */
export async function clearEmbeddingModelAction(): Promise<void> {
  const access = await requireChatAccess();
  const result = await consoleService().setEmbeddingModel(access, { embeddingModel: "" });
  // Clearing is refused only when the api limits the rate: rare enough to fail the action rather than fill a form.
  if (!result.ok) throw new Error(result.error ?? "the api refused to clear the embedding model");
  revalidatePath("/dashboard/chats/search-settings");
}
