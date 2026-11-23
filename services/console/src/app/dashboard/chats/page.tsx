import type { Metadata } from "next";
import Link from "next/link";
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
      <p>
        Search finds the chats that mention your words; with an embedding model set under{" "}
        <Link
          href="/dashboard/chats/search-settings"
          className="font-medium text-brand-text hover:text-brand-text/80"
        >
          Search settings
        </Link>
        , also the ones that mean the same.
      </p>
      <div className="pt-2">
        <ButtonLink href="/dashboard/chats/new">New chat</ButtonLink>
      </div>
    </EmptyState>
  );
}
