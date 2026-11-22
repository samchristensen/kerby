// Vitest globalSetup: starts disposable Postgres and RustFS containers for the whole run and hands their
// addresses to tests through `inject("containers")`. Torn down after the run. Containers carry the label
// `kerby-test=1` and the owning process id, so a run killed before teardown is cleaned up by the next one while
// runs in other worktrees keep theirs.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { TestProject } from "vitest/node";

export const POSTGRES_IMAGE = "postgres:18-alpine";
const RUSTFS_IMAGE = "rustfs/rustfs:1.0.6";

type TestContainers = {
  /** Superuser URL of a Postgres server; tests create their own databases on it. */
  postgresUrl: string;
  s3: { endpoint: string; accessKeyId: string; secretAccessKey: string };
};

declare module "vitest" {
  export interface ProvidedContext {
    containers: TestContainers;
  }
}

const LABEL = "kerby-test=1";
const OWNER = "kerby-test-owner";
const READY_TIMEOUT_MS = 60_000;

function docker(...args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function hostPort(name: string, containerPort: number): number {
  // `docker port` prints one `host:port` line per binding, e.g. `127.0.0.1:55001`.
  const line = docker("port", name, `${containerPort}/tcp`).split("\n")[0] ?? "";
  const port = Number(line.slice(line.lastIndexOf(":") + 1));
  if (!Number.isInteger(port))
    throw new Error(`no host port for ${name}:${containerPort}: "${line}"`);
  return port;
}

async function until(what: string, probe: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch {
      // not ready yet
    }
    await sleep(100);
  }
  throw new Error(
    `${what} was not ready after ${READY_TIMEOUT_MS / 1000}s. Fix: run \`docker logs\` on the container.`,
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remove test containers whose owning process is gone. Another run's containers stay. */
export function removeStale(alive: (pid: number) => boolean = isAlive): void {
  const lines = docker(
    "ps",
    "-a",
    "--filter",
    `label=${LABEL}`,
    "--format",
    `{{.ID}} {{.Label "${OWNER}"}}`,
  );
  const stale = lines
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [id = "", owner = ""] = line.split(" ");
      const pid = Number(owner);
      return Number.isInteger(pid) && pid > 0 && alive(pid) ? [] : [id];
    });
  if (stale.length > 0) docker("rm", "-f", ...stale);
}

/** @public vitest.config.ts names this file as `globalSetup`; vitest calls its default export. */
export default async function setup(project: TestProject): Promise<() => void> {
  removeStale();
  const suffix = randomBytes(4).toString("hex");
  const pg = `kerby-test-pg-${suffix}`;
  const s3 = `kerby-test-s3-${suffix}`;
  const teardown = () => {
    try {
      docker("rm", "-f", pg, s3);
    } catch {
      // already gone
    }
  };

  try {
    docker(
      "run",
      "-d",
      "--rm",
      "--name",
      pg,
      "--label",
      LABEL,
      "--label",
      `${OWNER}=${process.pid}`,
      "-e",
      "POSTGRES_PASSWORD=dev",
      "-p",
      "127.0.0.1::5432",
      POSTGRES_IMAGE,
      "-c",
      "max_connections=500",
      // Disposable data: trade durability for speed.
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off",
    );
    docker(
      "run",
      "-d",
      "--rm",
      "--name",
      s3,
      "--label",
      LABEL,
      "--label",
      `${OWNER}=${process.pid}`,
      "-e",
      "RUSTFS_ACCESS_KEY=devkey",
      "-e",
      "RUSTFS_SECRET_KEY=devsecret123",
      "-p",
      "127.0.0.1::9000",
      RUSTFS_IMAGE,
      "/data",
    );
    const pgPort = hostPort(pg, 5432);
    const s3Port = hostPort(s3, 9000);

    // pg_isready also answers during the image's init restart: require a real query, twice in a row.
    let ok = 0;
    await until("postgres", () => {
      docker("exec", pg, "psql", "-U", "postgres", "-tAc", "select 1");
      return ++ok >= 2;
    });
    await until("rustfs", async () => (await fetch(`http://127.0.0.1:${s3Port}/`)).status < 500);

    project.provide("containers", {
      postgresUrl: `postgres://postgres:dev@127.0.0.1:${pgPort}/postgres`,
      s3: {
        endpoint: `http://127.0.0.1:${s3Port}`,
        accessKeyId: "devkey",
        secretAccessKey: "devsecret123",
      },
    });
  } catch (error) {
    teardown();
    throw error;
  }
  return teardown;
}
