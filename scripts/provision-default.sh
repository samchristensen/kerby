#!/bin/sh
# Provision the `default` tenant in the running local stack, or mint a fresh key for it when it exists, and print the
# API key. Runs inside the control container, which is not published to the host.
set -eu
exec docker compose exec -T control node --input-type=module -e '
const base = "http://127.0.0.1:8081/v1/operator";
const headers = { authorization: `Bearer ${process.env.OPERATOR_TOKEN}`, "content-type": "application/json" };
const call = async (method, path, body) => {
  const response = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
  if (!response.ok && response.status !== 409) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response;
};
let response = await call("POST", "/tenants", { name: "default" });
if (response.status === 409) {
  const { tenants } = await (await call("GET", "/tenants")).json();
  const tenant = tenants.find((t) => t.name === "default");
  response = await call("POST", `/tenants/${tenant.id}/keys`, { label: "make up" });
}
console.log((await response.json()).secret);
'
