import type { Metadata } from "next";
import { ButtonLink, EmptyState } from "../../_components/ui.tsx";
import { requireSession } from "../../_lib/session.ts";

export const metadata: Metadata = { title: "Chats" };

export default async function ChatsPage() {
  await requireSession();
  return (
    <EmptyState
      title="Chats"
      icon={
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className="size-6"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4 4v-4H5.5A1.5 1.5 0 0 1 4 14.5v-9Z"
          />
        </svg>
      }
    >
      <p>
        Talk to your agent here, or open any conversation from the list: every conversation in your
        workspace is there, including the ones your own code starts through the API.
      </p>
      <p>
        A model needs a key from its provider: add one under Model providers before your first chat.
      </p>
      <div className="pt-2">
        <ButtonLink href="/dashboard/chats/new">New chat</ButtonLink>
      </div>
    </EmptyState>
  );
}
