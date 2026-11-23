import type { Metadata } from "next";
import { ButtonLink, EmptyState } from "../../_components/ui.tsx";
import { requireSession } from "../../_lib/session.ts";

export const metadata: Metadata = { title: "Studio" };

export default async function StudioPage() {
  await requireSession();
  return (
    <EmptyState title="Write prompts and decision models">
      <p>
        A chat prompt is a system prompt in markdown with its model, guardrails and{" "}
        <code className="font-mono">{"{{variables}}"}</code>. A decision model is the questions of a
        judgment. Edit a draft, publish it as a version, point labels at versions, and try either in
        its playground.
      </p>
      <p>Your code uses them by name and version or label; so does a new chat here.</p>
      <ButtonLink href="/dashboard/studio/new">New prompt</ButtonLink>
    </EmptyState>
  );
}
