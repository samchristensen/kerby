// The console's one call to another service: control's sign-up route, over the private network (ADR 0014).
import { ConsoleSignupResponseSchema } from "@kerby/contracts";
import { z } from "zod";
import type { SignupClient } from "../types/index.ts";

const ErrorBodySchema = z.object({ error: z.object({ code: z.string() }) });

/** Provisioning copies a database and migrates it: seconds, not minutes. */
const SIGNUP_TIMEOUT_MS = 60_000;

export function createSignupClient(controlUrl: string, token: string): SignupClient {
  const url = new URL("/v1/console/signups", controlUrl);
  return async (request) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(SIGNUP_TIMEOUT_MS),
    });
    if (response.status === 201) {
      return { ok: true, ...ConsoleSignupResponseSchema.parse(await response.json()) };
    }
    const code = ErrorBodySchema.safeParse(await response.json().catch(() => null)).data?.error
      .code;
    if (response.status === 409 && (code === "name_taken" || code === "email_taken")) {
      return { ok: false, code };
    }
    if (response.status === 403 && code === "not_invited") return { ok: false, code };
    // Anything else is a fault on our side (a bad token, control down): the person sees an error page, the log says why.
    throw new Error(`control refused a sign-up: ${response.status} ${code ?? "(no error code)"}`);
  };
}
