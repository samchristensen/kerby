import { defineConfig } from "vitest/config";

// Tests run against real Postgres and RustFS: scripts/test-containers.ts starts them (about 5 s) and
// tears them down. Each test makes its own databases and bucket prefix, so files run in parallel.
export default defineConfig({
  test: {
    globalSetup: ["./scripts/test-containers.ts"],
    include: ["{packages,services,scripts}/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
