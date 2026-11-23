// Where an authorization server sends the person back after they approved (or refused) Kerby: Kerby's OAuth redirect
// URI (ADR 0019). The person is signed in; the answer is handed to the api in their tenant, which finishes the
// connection only if this tenant began it.
import type { Metadata } from "next";
import { PageHeader } from "../../../../_components/ui.tsx";
import { requireChatAccess } from "../../../../_lib/session.ts";
import { Workspace } from "../../../_components/panes.tsx";
import { FinishConnection } from "../../server-forms.tsx";

export const metadata: Metadata = { title: "Connecting a tool server" };

/** What an authorization response carries (RFC 6749 section 4.1.2, RFC 9207). */
const ANSWER = ["state", "code", "iss", "error", "error_description"] as const;

export default async function OAuthCallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireChatAccess();
  const query = await searchParams;
  const answer: Record<string, string> = {};
  for (const name of ANSWER) {
    const value = query[name];
    if (typeof value === "string") answer[name] = value;
  }
  return (
    <Workspace>
      <PageHeader
        title="Connecting a tool server"
        description="The server's sign-in sent you back here; Kerby finishes the connection."
      />
      <FinishConnection answer={answer} />
    </Workspace>
  );
}
