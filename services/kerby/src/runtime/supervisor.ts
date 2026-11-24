// Runs an install's processes in one container (ADR 0024). Control starts first; the rest start once it answers its
// health, so they find the databases and the tenant ready. Each line a process writes to stdout gets its role as
// `service`, so the container's log still says who wrote it. When any process exits, the launcher stops the rest and
// exits nonzero, and Docker or Railway restarts the container: no partial install keeps running.
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { childProcessEnv } from "@kerby/config";
import { log } from "@kerby/observability";
import type { ProcessSpec } from "../service/processes.ts";

/** How long a process gets to finish after SIGTERM before it is killed. */
const STOP_GRACE_MS = 15_000;

/** Whether `url` answers 200 within a second. */
export async function healthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/** Kerby's lines are JSON objects: tag each with the role; pass anything else (a crash's stack) as it is. */
function tagLines(child: ChildProcess, role: string): void {
  if (!child.stdout) return;
  const prefix = `{"service":${JSON.stringify(role)},`;
  createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY }).on(
    "line",
    (line) => {
      process.stdout.write(line.startsWith("{") ? `${prefix}${line.slice(1)}\n` : `${line}\n`);
    },
  );
}

export function supervise(specs: readonly ProcessSpec[], options: { watch: boolean }): void {
  const running = new Map<string, ChildProcess>();
  let stopping = false;

  const stopAll = async (code: number) => {
    if (stopping) return;
    stopping = true;
    const exits = [...running.values()].map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once("exit", () => resolve());
          child.kill("SIGTERM");
        }),
    );
    const timer = setTimeout(() => {
      for (const child of running.values()) child.kill("SIGKILL");
    }, STOP_GRACE_MS);
    await Promise.all(exits);
    clearTimeout(timer);
    process.exit(code);
  };

  const start = (spec: ProcessSpec) => {
    const child = spawn(process.execPath, [...(options.watch ? ["--watch"] : []), spec.entry], {
      env: childProcessEnv(spec.env),
      stdio: ["ignore", "pipe", "inherit"],
    });
    running.set(spec.role, child);
    tagLines(child, spec.role);
    child.once("exit", (code, signal) => {
      if (stopping) return;
      log("error", "a process exited: stopping the others", {
        role: spec.role,
        exitCode: code,
        signal,
      });
      void stopAll(1);
    });
    return child;
  };

  process.on("SIGTERM", () => void stopAll(0));
  process.on("SIGINT", () => void stopAll(0));

  void (async () => {
    const [first, ...rest] = specs;
    if (first?.role === "control") {
      const control = start(first);
      // Control answers once it has migrated and made the install; until then the others would find nothing.
      while (!stopping && control.exitCode === null && !(await healthy(first.healthUrl))) {
        await sleep(250);
      }
      if (stopping) return;
      for (const spec of rest) start(spec);
    } else {
      for (const spec of specs) start(spec);
    }
    log("info", "kerby started", { roles: specs.map((spec) => spec.role).join(",") });
  })();
}
