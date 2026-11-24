// The kerby launcher (ADR 0024): one container runs an install's control, api, worker and dispatcher. It derives every
// key from KERBY_SECRET_KEY, hands each process what it needs, and supervises them. `health` is the image's
// HEALTHCHECK: healthy when every process this container runs answers. This file is the composition root.
import { deriveInstanceKeys } from "@kerby/secrets";
import { loadLauncherConfig } from "./config/index.ts";
import { healthy, supervise } from "./runtime/supervisor.ts";
import { processSpecs } from "./service/processes.ts";

if (import.meta.main) {
  const config = loadLauncherConfig();
  const specs = processSpecs(config, deriveInstanceKeys(config.kerbySecretKey));
  if (process.argv[2] === "health") {
    const answers = await Promise.all(specs.map((spec) => healthy(spec.healthUrl)));
    process.exit(answers.every(Boolean) ? 0 : 1);
  }
  supervise(specs, { watch: config.kerbyWatch });
}
