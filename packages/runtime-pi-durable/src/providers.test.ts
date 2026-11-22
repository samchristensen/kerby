import { describe, expect, it } from "vitest";
import { SUPPORTED_PROVIDERS } from "./provider-ids.ts";
import { createTenantModels, PROVIDERS } from "./providers.ts";

describe("supported providers", () => {
  it("the Pi-free id list (what the api checks) equals the provider map (what a run uses)", () => {
    expect([...SUPPORTED_PROVIDERS].sort()).toEqual(Object.keys(PROVIDERS).sort());
    for (const id of SUPPORTED_PROVIDERS)
      expect(createTenantModels(id, "sk-test-0123")).toBeDefined();
    expect(createTenantModels("nope", "sk-test-0123")).toBeUndefined();
  });
});
