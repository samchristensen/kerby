// Self-serve sign-up (ADR 0014): the console asks for a tenant and its first person in one call. Only an email on the
// allowlist may sign up. The console checks the password's strength and hashes it; control provisions as it does for
// an operator and stores the hash it was given.
import {
  audit,
  EmailTakenError,
  findConsoleUser,
  insertConsoleUser,
  isSignupAllowed,
  setConsoleAdmin,
} from "@kerby/control-plane";
import { errorFields, log, withTenant } from "@kerby/observability";
import { ConflictError, type ControlDeps, ForbiddenError, NotFoundError } from "../types/index.ts";
import { deleteTenant, type Provisioned, provisionTenant } from "./tenants.ts";

export type SignupRequest = { name: string; email: string; passwordHash: string };

/** Mark the person with `email` an admin of the console, or not. Audited to their tenant as the operator. */
export async function setAdmin(deps: ControlDeps, email: string, admin: boolean): Promise<void> {
  const user = await setConsoleAdmin(deps.control, email, admin);
  if (!user) throw new NotFoundError("no console account has this email");
  await audit(deps.control, {
    tenantId: user.tenantId,
    actor: "operator",
    action: "console.admin.set",
    detail: { userId: user.id, admin },
  });
}

export async function signUp(
  deps: ControlDeps,
  request: SignupRequest,
): Promise<Provisioned & { userId: string }> {
  // First, and before anything is provisioned: an address that was not invited learns nothing else about us.
  if (!(await isSignupAllowed(deps.control, request.email))) {
    throw new ForbiddenError("sign-up is by invitation", "not_invited");
  }
  if (await findConsoleUser(deps.control, request.email)) {
    throw new ConflictError("an account with this email exists", "email_taken");
  }
  const provisioned = await provisionTenant(deps, { name: request.name }, "console");
  const tenantId = provisioned.tenant.id;
  try {
    const user = await insertConsoleUser(deps.control, {
      tenantId,
      email: request.email,
      passwordHash: request.passwordHash,
    });
    await audit(deps.control, {
      tenantId,
      actor: "console",
      action: "console.signup",
      detail: { userId: user.id },
    });
    return { ...provisioned, userId: user.id };
  } catch (error) {
    // A tenant nobody can sign in to is removed whole: database, role, key.
    await deleteTenant(deps, tenantId).catch((cleanup: unknown) =>
      withTenant(tenantId, () => log("error", "sign-up cleanup failed", errorFields(cleanup))),
    );
    if (error instanceof EmailTakenError) throw new ConflictError(error.message, "email_taken");
    throw error;
  }
}
