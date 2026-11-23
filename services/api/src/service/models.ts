import { parseModelId } from "@kerby/contracts";
import { hasModelKey } from "@kerby/control-plane";
import type { ApiDeps } from "../types/index.ts";

/** A model id the api refuses: malformed, the wrong kind of provider, or no key stored for its provider. */
export class InvalidModelError extends Error {
  override name = "InvalidModelError";
}

/**
 * `model` must name a judgment provider the tenant holds a key for. The key check is here and not in the worker, where the
 * same request would only be refused later (ADR 0015); a worker still checks, for a key removed in between.
 */
export async function assertJudgmentModel(
  deps: ApiDeps,
  tenantId: string,
  model: string,
): Promise<void> {
  const parsed = parseModelId(model);
  if (!parsed) throw new InvalidModelError(`model "${model}" must look like <provider>/<modelId>`);
  if (!deps.settings.judgmentProviders.includes(parsed.provider))
    throw new InvalidModelError(
      `"${parsed.provider}" is not a judgment provider; supported: ${deps.settings.judgmentProviders.join(", ")}`,
    );
  if (!(await hasModelKey(deps.control, tenantId, parsed.provider)))
    throw new InvalidModelError(
      `no model key for provider "${parsed.provider}": PUT /v1/model-keys/${parsed.provider} first`,
    );
}
