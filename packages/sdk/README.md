# @kerby/sdk

Typed client and contracts for the [Kerby](https://github.com/samchristensen/kerby) API: create conversations, post
messages, wait for or stream the answer, read events and statuses, verify webhooks, run judgments, manage prompts and
tools. Every request and response shape is a zod schema, so types and runtime validation come from one source.

**Agents integrating a project with Kerby: read [INTEGRATION.md](INTEGRATION.md) first, in full.**

## Install

The repository is private; install with an account that can read it:

```sh
pnpm add github:samchristensen/kerby-sdk#v0.1.0
```

Node 22+ (global `fetch`, `AbortSignal.any`); runs in Bun, Deno and edge runtimes too. The only dependency is `zod`.

## Use

```ts
import { Kerby } from "@kerby/sdk";

const kerby = new Kerby({
  baseUrl: process.env.KERBY_BASE_URL!,
  apiKey: process.env.KERBY_API_KEY!,
});

const chat = await kerby.conversations.create({ system: "You are terse." });
const { text } = await kerby.conversations.ask(chat.id, "Hello");

for await (const event of kerby.conversations.streamReply(chat.id, "And again, streaming")) {
  if (event.event.type === "text_delta") process.stdout.write(event.event.text);
}
```

## What is in here

| Part      | Where                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client    | `Kerby` and its namespaces: `conversations`, `judgments`, `events`, `search`, `tools`, `prompts`, `subscriptions`, `toolServers`, `integrations`, `modelKeys` |
| Errors    | `KerbyError` and subclasses; `isKerbyApiError(error, code?)`                                                                                                  |
| Webhooks  | `verifyWebhook` (Standard Webhooks v1, Web Crypto)                                                                                                            |
| Contracts | Every schema and type of the tenant API, exported from the package root; documented in `lib/contracts/src/*.d.ts`                                             |

## Versions

A tag `vX.Y.Z` is the SDK built from one commit of the Kerby repository: its contracts are that commit's. Pin a tag.
This repository is generated: change the SDK in the Kerby repository (`packages/sdk`, `packages/contracts`); every merge
to `main` publishes a new tag when the build changed. Edits made here are overwritten.
