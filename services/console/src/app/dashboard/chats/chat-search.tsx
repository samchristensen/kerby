"use client";
// The search box over the conversations pane. A search runs as a server action, so the query never appears in a URL;
// while results are shown the list stays mounted (and refreshing) underneath, and "Clear" brings it back.
import Link from "next/link";
import { type FormEvent, type ReactNode, useState, useTransition } from "react";
import type { ChatSearchHitView } from "../../../types/index.ts";
import { NavLink } from "../../_components/client.tsx";
import { formatDateTime } from "../../_components/format.ts";
import { Alert, Badge } from "../../_components/ui.tsx";
import { listItemActiveClass, listItemClass } from "../_components/panes.tsx";
import { type SearchChatsState, searchChatsAction } from "./actions.ts";

function HitItem({ hit }: { hit: ChatSearchHitView }) {
  return (
    <li>
      <NavLink
        href={`/dashboard/chats/${hit.conversationId}`}
        className={listItemClass}
        activeClassName={listItemActiveClass}
      >
        <span className="flex items-center justify-between gap-2">
          <span
            className={`truncate text-sm font-medium ${hit.title ? "text-zinc-900" : "text-zinc-500 italic"}`}
          >
            {hit.title ?? "Untitled chat"}
          </span>
          <Badge tone={hit.role === "user" ? "indigo" : "zinc"}>
            {hit.role === "user" ? "User" : "Assistant"}
          </Badge>
        </span>
        <span className="mt-1 line-clamp-3 text-xs break-words text-zinc-600">{hit.snippet}</span>
        <span className="mt-1 block text-xs text-zinc-400">{formatDateTime(hit.createdAt)}</span>
      </NavLink>
    </li>
  );
}

function Results({ state }: { state: SearchChatsState }) {
  if (!state.ok) {
    return (
      <div className="p-3">
        <Alert tone="error">
          {state.error ?? state.fields?.query ?? "The search was refused."}
        </Alert>
      </div>
    );
  }
  const { hits, mode, notice } = state.result;
  return (
    <>
      <p className="px-4 pt-1 pb-2 text-xs text-zinc-500">
        {hits.length === 1 ? "1 chat" : `${hits.length} chats`} ·{" "}
        {mode === "hybrid" ? "words and meaning" : "words only"}
      </p>
      {notice ? (
        <div className="px-3 pb-3">
          <Alert tone="warning">{notice}</Alert>
        </div>
      ) : null}
      {hits.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-zinc-500">No chats match.</p>
      ) : (
        <ul className="border-t border-zinc-100">
          {hits.map((hit) => (
            <HitItem key={hit.conversationId} hit={hit} />
          ))}
        </ul>
      )}
    </>
  );
}

export function ChatSearch({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchChatsState | undefined>();
  const [pending, startTransition] = useTransition();

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim()) return;
    startTransition(async () => {
      setState(await searchChatsAction(query));
    });
  }

  function clear() {
    setQuery("");
    setState(undefined);
  }

  return (
    <>
      <form
        onSubmit={search}
        className="sticky top-0 z-10 flex gap-2 border-b border-zinc-100 bg-white p-3"
      >
        <input
          type="search"
          aria-label="Search chats"
          placeholder="Search chats"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            // The search field's own clear button empties it: that ends the search too.
            if (!event.target.value) setState(undefined);
          }}
          maxLength={1000}
          className="block min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 shadow-sm placeholder:text-zinc-400 focus:outline-2 focus:outline-offset-0 focus:outline-indigo-500"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg px-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-60"
        >
          {pending ? "Searching…" : "Search"}
        </button>
        {state ? (
          <button
            type="button"
            onClick={clear}
            className="rounded-lg px-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
          >
            Clear
          </button>
        ) : null}
      </form>
      {state ? (
        <>
          <Results state={state} />
          <p className="px-4 py-3 text-xs text-zinc-400">
            <Link href="/dashboard/chats/search-settings" className="hover:text-zinc-600">
              Search settings
            </Link>
          </p>
        </>
      ) : null}
      <div hidden={state !== undefined}>{children}</div>
    </>
  );
}
