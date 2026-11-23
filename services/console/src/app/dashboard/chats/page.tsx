import type { Metadata } from "next";
import { ButtonLink, EmptyState } from "../../_components/ui.tsx";
import { requireSession } from "../../_lib/session.ts";

export const metadata: Metadata = { title: "Chats" };

export default async function ChatsPage() {
  await requireSession();
  return (
    <EmptyState title="Chats">
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
