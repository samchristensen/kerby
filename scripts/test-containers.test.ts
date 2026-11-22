import { execFileSync, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { expect, inject, test } from "vitest";
import { POSTGRES_IMAGE, removeStale } from "./test-containers.ts";

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();

test("postgres container accepts connections at the provided URL", async () => {
  const url = new URL(inject("containers").postgresUrl);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const socket = connect({ host: url.hostname, port: Number(url.port) }, () => {
    socket.end();
    resolve();
  });
  socket.on("error", reject);
  await promise;
});

test("s3 container answers at the provided endpoint", async () => {
  const response = await fetch(inject("containers").s3.endpoint);
  expect(response.status).toBeLessThan(500);
});

test("stale cleanup removes only containers whose owning run is gone", () => {
  // A process that has exited: its pid names a run that was killed before teardown.
  const dead = spawnSync("true").pid;
  const start = (owner: number) =>
    docker(
      "run",
      "-d",
      "--rm",
      "--label",
      "kerby-test=1",
      "--label",
      `kerby-test-owner=${owner}`,
      POSTGRES_IMAGE,
      "sleep",
      "300",
    );
  const orphan = start(dead);
  const live = start(process.pid);
  try {
    removeStale();
    const left = docker("ps", "-aq", "--no-trunc", "--filter", "label=kerby-test=1");
    expect(left).not.toContain(orphan);
    expect(left).toContain(live);
    // This run's own containers survive too.
    expect(() => inject("containers")).not.toThrow();
  } finally {
    // The orphan is gone already, or the next run's cleanup takes it.
    docker("rm", "-f", live);
  }
});
