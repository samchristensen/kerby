// The platform owner's controls: who may sign up. An admin is a person the operator marked (control's
// `POST /v1/operator/console-admins`); the console's database role can read that flag and never write it. Every method
// checks it again here, so a page that forgets to is not the only guard. Changes are audited as `user:<id>`, with counts
// and never addresses.
import { EmailSchema } from "@kerby/contracts";
import { allowEmails, audit, disallowEmail, listAllowedEmails } from "@kerby/control-plane";
import { z } from "zod";
import type {
  AllowedEmailView,
  ConsoleDeps,
  FormFailure,
  FormInput,
  Session,
} from "../types/index.ts";
import { parseForm } from "./forms.ts";

/** Addresses one submission may carry. */
const MAX_EMAILS = 100;

const AllowForm = z.object({
  emails: z
    .string()
    .max(20_000, "too long")
    .transform((text) => text.split(/[\s,;]+/).filter(Boolean))
    .pipe(
      z
        .array(EmailSchema)
        .min(1, "enter at least one email address")
        .max(MAX_EMAILS, `at most ${MAX_EMAILS} addresses at a time`),
    ),
});

function requireAdmin(session: Session): void {
  if (!session.isAdmin) throw new Error("only an admin edits the sign-up allowlist");
}

export function createAdmin(deps: ConsoleDeps) {
  const { control } = deps;
  return {
    async signupAllowlist(session: Session): Promise<AllowedEmailView[]> {
      requireAdmin(session);
      return (await listAllowedEmails(control)).map((entry) => ({
        email: entry.email,
        addedAt: entry.addedAt.toISOString(),
        signedUp: entry.signedUp,
      }));
    },

    async allowSignups(
      session: Session,
      form: FormInput,
    ): Promise<{ ok: true; added: number } | FormFailure> {
      requireAdmin(session);
      const parsed = parseForm(AllowForm, form);
      if (!parsed.ok) return parsed;
      const added = await allowEmails(control, [...new Set(parsed.data.emails)], session.userId);
      await audit(control, {
        tenantId: session.tenantId,
        actor: `user:${session.userId}`,
        action: "console.allowlist.add",
        detail: { added },
      });
      return { ok: true, added };
    },

    async disallowSignup(session: Session, email: string): Promise<boolean> {
      requireAdmin(session);
      const parsed = EmailSchema.safeParse(email);
      if (!parsed.success) return false;
      const removed = await disallowEmail(control, parsed.data);
      if (removed) {
        await audit(control, {
          tenantId: session.tenantId,
          actor: `user:${session.userId}`,
          action: "console.allowlist.remove",
        });
      }
      return removed;
    },
  };
}
