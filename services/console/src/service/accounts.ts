// Sign-up, sign-in and sessions. Before anyone is signed in, the work an address can cause is bounded: sign-ups per
// address per hour (each provisions a database), failed sign-ins per address per minute and per account per hour.
// The counters are this process's (TokenBuckets): with N console processes, N times the limits.
import { EmailSchema, TenantNameSchema } from "@kerby/contracts";
import {
  audit,
  createConsoleSession,
  deleteConsoleSession,
  findConsoleUser,
  getTenant,
  readConsoleSession,
} from "@kerby/control-plane";
import { log, withTenant } from "@kerby/observability";
import { TokenBuckets } from "@kerby/serve";
import { z } from "zod";
import type { ConsoleDeps, FormFailure, FormInput, Session, SignedIn } from "../types/index.ts";
import { parseForm, refuse, retryIn } from "./forms.ts";
import { hashPassword, verifyPassword } from "./passwords.ts";

const SignUpForm = z.object({
  name: TenantNameSchema,
  email: EmailSchema,
  password: z.string().min(10, "at least 10 characters").max(200, "at most 200 characters"),
});

const LogInForm = z.object({ email: EmailSchema, password: z.string().min(1).max(200) });

/** Addresses and accounts each limiter remembers. */
const MAX_LIMITER_KEYS = 100_000;
const HOUR_MS = 3_600_000;

export function createAccounts(deps: ConsoleDeps) {
  const { control, settings } = deps;
  const signups = new TokenBuckets({ maxKeys: MAX_LIMITER_KEYS, windowMs: HOUR_MS });
  const failedByAddress = new TokenBuckets({ maxKeys: MAX_LIMITER_KEYS });
  const failedByAccount = new TokenBuckets({ maxKeys: MAX_LIMITER_KEYS, windowMs: HOUR_MS });
  // An unknown email still costs one hash, so the time taken does not tell which emails have accounts.
  let decoy: Promise<string> | undefined;

  async function startSession(user: { id: string; tenantId: string }): Promise<SignedIn> {
    const expiresAt = new Date(Date.now() + settings.sessionTtlMs);
    const token = await createConsoleSession(control, user, expiresAt);
    return { ok: true, token, expiresAt: expiresAt.toISOString() };
  }

  return {
    async signUp(
      form: FormInput,
      client: string,
    ): Promise<(SignedIn & { apiKey: string }) | FormFailure> {
      const parsed = parseForm(SignUpForm, form);
      if (!parsed.ok) return parsed;
      const wait = signups.take(client, settings.signupsPerHour);
      if (wait > 0)
        return refuse(`Too many sign-ups from your network. Try again ${retryIn(wait)}.`);
      const { name, email, password } = parsed.data;
      const created = await deps.signups({
        name,
        email,
        passwordHash: await hashPassword(password, settings.passwordCost),
      });
      if (!created.ok) {
        if (created.code === "not_invited") {
          return {
            ok: false,
            fields: {
              email: "Sign-up is by invitation for now, and this email is not on the list.",
            },
          };
        }
        return created.code === "name_taken"
          ? { ok: false, fields: { name: "This workspace name is taken" } }
          : { ok: false, fields: { email: "An account with this email exists. Sign in instead." } };
      }
      withTenant(created.tenantId, () =>
        log("info", "console sign-up", { userId: created.userId }),
      );
      const session = await startSession({ id: created.userId, tenantId: created.tenantId });
      return { ...session, apiKey: created.secret };
    },

    async logIn(form: FormInput, client: string): Promise<SignedIn | FormFailure> {
      const parsed = parseForm(LogInForm, form);
      if (!parsed.ok) return refuse("Enter your email and password.");
      const { email, password } = parsed.data;
      const wait = Math.max(
        failedByAddress.wait(client, settings.failedLoginsPerMinute),
        failedByAccount.wait(email, settings.failedLoginsPerAccountPerHour),
      );
      if (wait > 0) return refuse(`Too many failed sign-ins. Try again ${retryIn(wait)}.`);

      const user = await findConsoleUser(control, email);
      decoy ??= hashPassword("decoy password", settings.passwordCost);
      const matches = await verifyPassword(password, user?.passwordHash ?? (await decoy));
      if (!user || !matches) {
        failedByAddress.take(client, settings.failedLoginsPerMinute);
        failedByAccount.take(email, settings.failedLoginsPerAccountPerHour);
        return refuse("Wrong email or password.");
      }
      const tenant = await getTenant(control, user.tenantId);
      if (tenant?.status !== "active") {
        return refuse("This workspace is not active. Contact support to restore it.");
      }
      const session = await startSession(user);
      await audit(control, {
        tenantId: user.tenantId,
        actor: `user:${user.id}`,
        action: "console.login",
      });
      return session;
    },

    async logOut(token: string): Promise<void> {
      await deleteConsoleSession(control, token);
    },

    async session(token: string): Promise<Session | undefined> {
      const found = await readConsoleSession(control, token);
      // A suspended or deleted tenant's sessions stop at once.
      if (found?.tenantStatus !== "active") return undefined;
      return {
        userId: found.userId,
        email: found.email,
        tenantId: found.tenantId,
        tenantName: found.tenantName,
        isAdmin: found.isAdmin,
      };
    },
  };
}
