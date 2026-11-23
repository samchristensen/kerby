# 0008. Tenants bring their own model keys, sealed to a key the api cannot use

- Status: proposed
- Date: 2026-11-22

## Context

Kerby is sold as a service to untrusted tenants. If Kerby paid for model calls it would carry every tenant's spend, hold
one provider key whose leak costs the operator, and pick the vendor for everyone. A tenant's own key makes the tenant pay
its provider directly, and lets it use any provider the harness supports. A stored key is a credential that must survive a
leak of the control database, of the internet-facing api, and of any log.

## Decision

- **Bring your own key, no platform key.** A model id is `<provider>/<modelId>` ([contracts](../../packages/contracts/src/model.ts)).
  A tenant stores one key per provider (`PUT /v1/model-keys/<provider>`, listed without the key, deleted with `DELETE`).
  A conversation and every turn need the tenant's key for the model's provider. The worker has no provider keys of its own;
  only the development fake model runs without one.
- **The adapter, not Kerby, knows providers.** `AgentRun.apiKey` carries the opened key for one run; the Pi Durable adapter
  builds a `Models` for that one provider and key per run (`createTenantModels`), so nothing is shared across runs or tenants.
  Adding a provider is one line in the adapter. The adapter also exports the bare id list from a subpath that loads no
  harness code (`@kerby/runtime-pi-durable/providers`); the api's composition root injects it, and `PUT` for any other id
  is a 400 `unknown_provider` naming the supported ones. Cloud-account providers (Bedrock, Vertex, Azure) and OAuth logins are out:
  their credentials are not one string. A different harness brings its own provider list; the port is unchanged.
- **Sealed to a public key.** [`packages/secrets`](../../packages/secrets/src/index.ts) seals a secret with an ephemeral X25519
  agreement, HKDF-SHA256 and AES-256-GCM (Node's `crypto`, no dependency): every secret has its own data key. The platform
  public key (`SECRETS_PUBLIC_KEY`) goes to the api, which can store a key but never read it back. The private key
  (`SECRETS_PRIVATE_KEYS`) goes to the worker only, which opens a key inside the run that needs it. Control holds neither.
- **Bound to its owner.** The tenant id and secret name are authenticated data: a ciphertext copied to another tenant's row,
  or another name, fails to open. The ciphertext names the key it was sealed to, so rotation is: make a new pair, give the
  api the new public key, give workers `new,old`, re-store keys at leisure, drop `old`.
- **The key does not leave the run.** The worker scrubs the key from provider errors before they reach `last_error`, the live
  stream, Absurd's failure record or a log; the api never returns a key; audit rows hold the provider, never the value.
  Keys are printable ASCII without spaces (no header injection), at most 32 per tenant.
- **Where the private key lives.** On Railway (no key-management service) as a variable on `worker`, generated once by
  `scripts/railway.ts` and never replaced on a live system: losing it strands every stored key. Anyone who can read
  `worker`'s variables can open tenants' keys; the Railway-login debt in `tech-debt.md` covers the same people.

## Consequences

- The api, an internet-facing service, is no longer a place to steal keys; a control-database dump alone yields nothing.
- A worker compromise exposes keys of the tenants it runs while it runs them, as any design that must use the key does.
- A tenant with no key gets a 400 at conversation creation, or a conversation `lastError` when a turn finds the key gone.
- Local development uses a committed dev key pair in `compose.yaml` (the same status as its other dev secrets).
- Tool credentials take the same path (ADR 0019): a tool server's header value is sealed by the api as
  `tool-credential/<serverId>` and opened only by a worker; they do not count against the 32 model keys.
