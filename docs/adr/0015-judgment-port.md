# 0015. Judgments: a provider-agnostic port, TypeSafe's Jev first

- Status: proposed
- Date: 2026-11-22

## Context

An agent decides what to do next; a lot of software around it only needs a narrow, typed answer to a question about some
text or data: is this message about billing, which of these three teams should take it, how urgent is it. TypeSafe's
System One models (Jev first) answer exactly that: a request holds a `state` and named `questions` of three kinds, `noul`
(the probability a statement is true), `choice` (one of named options, with every option's probability) and `score` (a
position on an ordered scale), and the response holds one typed answer per question with calibrated probabilities, in about
100 ms ([docs](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md)). Tenants want that as a call of their
own, and want their agents to use it mid-turn. Jev is the only provider today; others will follow, so the contract must not
be TypeSafe's wire format.

## Decision

- **A port, `packages/judgment`, types only** ([source](../../packages/judgment/src/index.ts)), as `packages/agent` is for
  harnesses (ADR 0003): `JudgmentProvider.judge(JudgmentRun)` returns a `JudgmentOutcome`, `answered` (one `Answer` per
  question, the model that answered, token usage) or `refused` (the provider rejected the request itself: a bad key, an
  invalid question; a retry gets the same answer). Infrastructure failures throw, so the task retries. The port carries
  no tenant, user or conversation id.
- **Probabilities are part of the contract.** Every answer carries them (`noul`: the probability; `choice` and `score`:
  the whole distribution and a `confidence`), because callers threshold on them. A provider that cannot produce
  calibrated probabilities does not implement the port; one that approximates them (say, from logprobs) says so in its own
  documentation, not in the port.
- **An adapter per provider, `packages/judgment-<provider>`.** The first is `packages/judgment-typesafe` (see the amendment: now
  `judgment-systemone`): the only code that knows `POST /v1/systemone`. It uses `fetch` (no SDK, no new dependency), never follows a redirect (the key is in a
  header), bounds each call (30 s), refuses 4xx other than 408/409/429 as `refused` and throws everything else, clamps
  probabilities into 0 to 1, and checks that the response answers exactly the questions asked. Its `providers` subpath
  exports the bare id list (`typesafe`) without loading the adapter, as the Pi adapter does for chat providers (ADR 0008).
  Only a service's `src/index.ts` imports an adapter.
- **Contracts mirror the port** (`packages/contracts/src/judgment.ts`, compile-time equal to the port types) and bound what
  a tenant may send: at most 32 questions, 10 score levels, 255 options, JSON at most 32 levels deep (checked without
  recursion), and no question or option named `__proto__`.
- **Bring your own key, as ever** (ADR 0008). A tenant stores its TypeSafe key at `PUT /v1/model-keys/typesafe`. The key
  providers a tenant may store are now two lists the composition roots inject: chat (`modelProviders`) and judgment
  (`judgmentProviders`). A judgment provider cannot be a conversation's model (400 `invalid_model`). The worker opens the
  key inside the run that uses it and scrubs it from every error and refusal; the api, which cannot open keys, never calls
  a provider.
- **Over HTTP it is asynchronous**: `POST /v1/judgments` (`{ model?, state, questions }`; model defaults to
  `typesafe/jev-latest`) checks the request, the provider and that the tenant has a key, enqueues a `run-judgment` Absurd
  task in the tenant's database and answers 202 `{ id }`. A worker runs it and stores the outcome as the task's result;
  `GET /v1/judgments/:id` answers `pending`, `running`, `answered`, `refused` or `failed` (the last for a task that ran out
  of attempts: the provider could not be reached; the message never carries the provider's words). The id is the task id,
  and only a `run-judgment` task answers to it. Bodies are capped at 256 KiB because the request is the task's params.
- **A judgment is also an agent tool**: `judge`, offered to a conversation only when the tenant has a key for the default
  judgment provider (a tool that can only fail invites the model to try it). The model's input is parsed with the same
  schema as the API's and a mistake comes back as a tool error that says what to fix. The call is inside the tool's own
  Absurd step, so a retried turn does not ask twice.
- **No table.** The request and its outcome live as the task's params and result in the tenant's database (Absurd's
  retention deletes them after 30 days, `cleanup`). Usage goes to the control plane's `usage` table once per judgment
  (`judgment:<taskId>` or `judgment:<conversationId>:<toolCallId>`), model `<provider>/<served model>`.

## Consequences

- A judgment runs on the `turns` queue and takes one of the tenant's concurrent-turn slots (`maxConcurrentTurns`, the
  worker's `MAX_RUNNING_TURNS`). That bounds what an untrusted tenant can make a worker do and reuses the scheduler, the
  notification and the fencing, at a price: a tenant whose slots are all busy with long turns waits to get its 100 ms
  judgment answered. A queue of its own needs a tenant migration, a second claim loop and its own limit; do it when
  judgments are slow or frequent enough to starve turns, or the reverse.
- A tenant's `state` sits in Absurd's params for 30 days in its own database: not message-body-sized (256 KiB at most) but
  more than references, which is what `tasks.ts` otherwise promises.
- A request travels through `jsonb`, which does not keep object key order: a choice's options and the questions reach the
  provider sorted (by length, then alphabetically), not as the tenant wrote them. A score's levels are an array and keep
  their order.
- `GET` polls; there is no stream or callback. Round trips cost more than the model: a caller that wants an answer in one
  request needs a different shape (the worker answering a request the api is holding), which this ADR does not decide.
- The development fake model has no judgment stand-in: with `KERBY_FAKE_MODEL=1` there is no key opener, so a judgment is
  `refused` (no key) and the `judge` tool is not offered. To run the path offline, start the stack with
  `KERBY_FAKE_MODEL=0` and `KERBY_TYPESAFE_BASE_URL` pointing at a stand-in (that is how this ADR's smoke run was done).
- A second provider is one package, one line in `JUDGMENT_PROVIDERS`-style lists of the api, console and worker roots, and
  a conformance suite on the port; until then the port is v0 and may change by editing `packages/judgment` and its one
  adapter.

## Amendment: OpenCode's decision models (2026-11-22)

OpenCode Console serves System One at `https://opencode.ai/inference/systemone/v1/systemone`, the same request and response
as TypeSafe's, with the tenant's OpenCode key and its own model ids: `jev-1.14`, `jev-1.13`, `jev-1.13-free`, and its own
`gpt-6-luna-decision` and `gemini-decision-1`
([docs](https://opencode.ai/docs/console/models/)). So:

- **One adapter per wire format, not per vendor.** `packages/judgment-typesafe` became `packages/judgment-systemone`:
  `createSystemOneJudgments("typesafe" | "opencode", { baseUrl?, timeoutMs? })`. The provider id is the model id's prefix
  (`opencode/jev-1.14`; the adapter strips it), and only messages and the default endpoint differ. A provider with another
  wire format gets its own package, as ever.
- **`opencode` is both a chat and a decision provider, and one key serves both.** The Pi adapter already lists `opencode`
  (ADR 0008); `JUDGMENT_PROVIDERS` lists it too. The composition roots keep the two lists apart: the key providers a tenant
  may store are their union, listed once; `ProviderView.chat` and `.decisions` say what a key is for (the console shows it);
  only a provider in `judgmentProviders` and not in `modelProviders` is refused as a conversation's model.
- **Choosing is by model id, not a switch.** The default stays `typesafe/jev-latest`; a request, a guardrail (`model`) or the
  `judge` tool names `opencode/<model>` to use it. A tenant without a key for the provider a model names is refused at the
  api (400 `invalid_model`), or fails closed in the worker if the key went away since. A per-tenant default is not built.
- **Unverified against the live gateway**: the wire format and endpoint are from OpenCode's documentation and a stand-in
  server; no OpenCode key was used. OpenCode's decision models also accept images, audio, video and PDFs in `state`; the
  port's `state` is JSON, so Kerby does not use that.
- `OPENCODE_SYSTEMONE_BASE_URL` (worker) overrides the gateway, as `TYPESAFE_BASE_URL` does TypeSafe's.

## Amendment: `judge` is offered only when named (2026-11-23)

Tools are never implied (ADR 0022): the agent's tool is `kerby/judge`, a built-in of the reserved server `kerby`, offered
only to a conversation (or chat prompt) that names it, and still only when the tenant holds a key for the default judgment
provider. Naming it without that key is 400 `unknown_tool` at creation; a key removed since leaves it out of the turn. An
integration without `admin` needs it granted like any tool. The model calls it `kerby__judge`.
