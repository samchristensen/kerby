"use client";
// The conversations pane: the first page from the server, refreshed every few seconds (a chat the tenant's code
// starts through the API shows up without a reload), and further pages on demand.
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { ChatListView, ChatSummaryView } from "../../../types/index.ts";
import { NavLink } from "../../_components/client.tsx";
import { formatDateTime } from "../../_components/format.ts";
import { Badge } from "../../_components/ui.tsx";
import { listItemActiveClass, listItemClass } from "../_components/panes.tsx";
import { listChatsAction } from "./actions.ts";

const REFRESH_MS = 8_000;

function ChatItem({ chat }: { chat: ChatSummaryView }) {
  return (
    <li>
      <NavLink
        href={`/dashboard/chats/${chat.id}`}
        className={listItemClass}
        activeClassName={listItemActiveClass}
      >
        <span className="flex items-center justify-between gap-2">
          <span
            className={`truncate text-sm font-medium ${chat.title ? "text-zinc-900" : "text-zinc-500 italic"}`}
          >
            {chat.title ?? "Untitled chat"}
          </span>
          {chat.origin === "console" ? (
            <Badge tone="indigo">Console</Badge>
          ) : chat.origin === "studio" ? (
            <Badge tone="green">Studio</Badge>
          ) : (
            <Badge tone="zinc">API</Badge>
          )}
        </span>
        <span className="mt-1 flex items-center justify-between gap-2 text-xs text-zinc-500">
          <code className="truncate font-mono">{chat.model}</code>
          <span className="shrink-0">{formatDateTime(chat.updatedAt)}</span>
        </span>
        {chat.origin === "api" && chat.externalUserId ? (
          <span className="mt-0.5 block truncate text-xs text-zinc-400">
            user {chat.externalUserId}
          </span>
        ) : null}
      </NavLink>
    </li>
  );
}

export function ChatList({ initial }: { initial: ChatListView }) {
  // The newest page, refreshed; and the pages "Load older chats" added after it, with where the next one starts.
  const [head, setHead] = useState(initial);
  const [older, setOlder] = useState<ChatListView | undefined>();
  const [loading, setLoading] = useState(false);
  const pathname = usePathname();

  // Again on every navigation too: a chat just made is at the top.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (document.visibilityState === "hidden") return;
      const page = await listChatsAction().catch(() => undefined);
      if (!cancelled && page) setHead(page);
    };
    void refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pathname]);

  const cursor = older ? older.nextCursor : head.nextCursor;
  const inHead = new Set(head.chats.map((chat) => chat.id));
  const chats = [...head.chats, ...(older?.chats ?? []).filter((chat) => !inHead.has(chat.id))];

  async function loadOlder() {
    if (!cursor) return;
    setLoading(true);
    try {
      const page = await listChatsAction(cursor);
      setOlder({ chats: [...(older?.chats ?? []), ...page.chats], nextCursor: page.nextCursor });
    } finally {
      setLoading(false);
    }
  }

  if (chats.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-sm text-zinc-500">
        No conversations yet. Start one here, or call the API.
      </p>
    );
  }
  return (
    <>
      <ul>
        {chats.map((chat) => (
          <ChatItem key={chat.id} chat={chat} />
        ))}
      </ul>
      {cursor ? (
        <div className="p-3">
          <button
            type="button"
            onClick={loadOlder}
            disabled={loading}
            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 disabled:opacity-60"
          >
            {loading ? "Loading…" : "Load older chats"}
          </button>
        </div>
      ) : null}
    </>
  );
}
