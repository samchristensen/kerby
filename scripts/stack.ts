// The running local stack (`make up`), as the real-stack scripts reach it.
import { execFileSync } from "node:child_process";

/** The install's configured API key (`KERBY_API_KEY` in the running kerby container), with every scope. */
export function stackApiKey(): string {
  return execFileSync("docker", ["compose", "exec", "-T", "kerby", "printenv", "KERBY_API_KEY"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}
