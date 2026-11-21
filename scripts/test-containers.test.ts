import { connect } from "node:net";
import { expect, inject, test } from "vitest";

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
