import type { Metadata } from "next";
import { ConfirmAction } from "../../_components/client.tsx";
import { formatDate } from "../../_components/format.ts";
import { Badge, Card, PageHeader } from "../../_components/ui.tsx";
import { consoleService } from "../../_lib/console.ts";
import { requireAdmin } from "../../_lib/session.ts";
import { Workspace } from "../_components/panes.tsx";
import { disallowSignupAction } from "./actions.ts";
import { AllowSignupsForm } from "./form.tsx";

export const metadata: Metadata = { title: "Sign-ups" };

export default async function AdminPage() {
  const session = await requireAdmin();
  const allowed = await consoleService().signupAllowlist(session);
  return (
    <Workspace>
      <PageHeader
        title="Sign-ups"
        description="Only these email addresses can create a workspace. Everyone else is turned away at the sign-up form."
      />
      <Card title="Allow an address">
        <AllowSignupsForm />
      </Card>
      <div className="mt-6">
        <Card title={`Allowed addresses (${allowed.length})`}>
          {allowed.length === 0 ? (
            <p className="text-sm text-muted">Nobody can sign up.</p>
          ) : (
            <ul className="divide-y divide-line">
              {allowed.map((entry) => (
                <li key={entry.email} className="flex flex-wrap items-center gap-3 py-2.5">
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">{entry.email}</span>
                  {entry.signedUp ? (
                    <Badge tone="live">Signed up</Badge>
                  ) : (
                    <Badge tone="neutral">Invited</Badge>
                  )}
                  <span className="text-xs text-muted">{formatDate(entry.addedAt)}</span>
                  <ConfirmAction
                    action={disallowSignupAction.bind(null, entry.email)}
                    label="Remove"
                    question={
                      entry.signedUp
                        ? "Remove this address? Its account keeps working; it just cannot sign up again."
                        : "Remove this address? It will no longer be able to sign up."
                    }
                    confirmLabel="Remove"
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Workspace>
  );
}
