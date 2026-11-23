// What the chat and Studio services share about talking to the api: reading its error body, the end-user names the
// console gives the conversations it starts, the model-key check before a model is used, and variables typed in a form.
import { PromptVariableNameSchema, parseModelId } from "@kerby/contracts";
import { hasModelKey } from "@kerby/control-plane";
import { z } from "zod";
import type { ConsoleDeps, FormInput } from "../types/index.ts";

/** A conversation started from the console's chat carries this end-user name. */
export const CONSOLE_USER_PREFIX = "console:";
/** A conversation started from the Studio's playground carries this one. */
export const STUDIO_USER_PREFIX = "studio:";

const ErrorBodySchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

/** The api's `{ error: { code, message } }`; a body without one (a proxy's page) has neither. */
export async function apiError(
  response: Response,
): Promise<{ code: string | undefined; message: string | undefined }> {
  const body = ErrorBodySchema.safeParse(await response.json().catch(() => null));
  return { code: body.data?.error.code, message: body.data?.error.message };
}

/** A fault the person cannot fix (5xx, a bad credential): thrown, never shown. */
export const apiFault = (what: string, status: number, code: string | undefined): Error =>
  new Error(`the api refused a ${what} request: ${status} ${code ?? "(no error code)"}`);

/**
 * Why `model` cannot run yet, in the form's words: its provider is one chats run on and the tenant has no key for it.
 * Undefined when it can (or when the provider is not one this check knows: the api decides).
 */
export async function missingModelKey(
  deps: ConsoleDeps,
  tenantId: string,
  model: string | undefined,
): Promise<string | undefined> {
  const provider = model ? parseModelId(model)?.provider : undefined;
  if (
    provider &&
    deps.settings.modelProviders.includes(provider) &&
    !(await hasModelKey(deps.control, tenantId, provider))
  ) {
    return `No ${provider} key yet: add one under Model providers.`;
  }
  return undefined;
}

/** Form field `var.<name>` holds the value of variable `name`. */
const VARIABLE_FIELD_PREFIX = "var.";

/** The variables typed in a form; a blank one is left out, so the variable's default applies. */
export function variableValues(form: FormInput): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [field, value] of Object.entries(form)) {
    if (!field.startsWith(VARIABLE_FIELD_PREFIX) || typeof value !== "string" || value === "") {
      continue;
    }
    const name = field.slice(VARIABLE_FIELD_PREFIX.length);
    if (PromptVariableNameSchema.safeParse(name).success) values[name] = value;
  }
  return values;
}
