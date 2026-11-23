// The console's one call to another service (ADR 0014): at sign-up, control provisions a tenant and its first person.
// The console's own token (CONSOLE_TOKEN) opens this route and nothing else. A refusal is 403 `not_invited` (the
// email is not on the sign-up allowlist), 409 `name_taken` or `email_taken`, or 400 for a body this schema refuses.
import { z } from "zod";
import { TenantNameSchema } from "./operator.ts";

/** An email as the console keeps it: trimmed and lower-cased, so one address is one account. */
export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email("an email address like you@example.com"));

/** `scrypt$<log2 N>$<r>$<p>$<salt>$<hash>` (base64), made by the console: control stores it and never sees a password. */
const PasswordHashSchema = z
  .string()
  .max(512)
  .regex(
    /^scrypt\$\d{1,2}\$\d{1,2}\$\d{1,2}\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/,
    "a password hash made by the console",
  );

export const ConsoleSignupRequestSchema = z.object({
  name: TenantNameSchema,
  email: EmailSchema,
  passwordHash: PasswordHashSchema,
});

/** `secret` is the tenant's first API key, returned once, here. */
export const ConsoleSignupResponseSchema = z.object({
  tenantId: z.uuid(),
  userId: z.uuid(),
  secret: z.string(),
});
export type ConsoleSignupResponse = z.infer<typeof ConsoleSignupResponseSchema>;

/** The operator marks a console person an admin, or not (`POST /v1/operator/console-admins`): 404 for no such account. */
export const SetConsoleAdminRequestSchema = z.object({ email: EmailSchema, admin: z.boolean() });
