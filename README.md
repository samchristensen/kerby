# Kerby

A self-hosted agent runtime. Run one install beside a project, in Docker Compose or inside its Railway project; your
application calls it over HTTP, and it runs the agents durably, calls the tools you register, and keeps every
transcript. Postgres is the only service it needs, plus S3-compatible storage for message bodies.

Kerby is pre-1.0 and built in public: expect rough edges, and tell me about them.

## Try it

You need Docker (and `make`).

```sh
make up
```

builds the stack and prints the API address, an API key and the console's address. It answers with a scripted model, so
no provider key is needed to see a turn run; [ARCHITECTURE.md](ARCHITECTURE.md#local-stack) says how to use a real one.

## Use it from an application

```sh
npm install @samchristensen/kerby-sdk      # or pnpm add / yarn add
```

```ts
import { Kerby } from "@samchristensen/kerby-sdk";

const kerby = new Kerby({
  baseUrl: process.env.KERBY_BASE_URL!,
  apiKey: process.env.KERBY_API_KEY!,
});

const chat = await kerby.conversations.create({ system: "You are terse." });
const { text } = await kerby.conversations.ask(chat.id, "Hello");
```

The SDK is typed end to end (every request and response is a zod schema). Its guide,
[packages/sdk/INTEGRATION.md](packages/sdk/INTEGRATION.md), is written for a person or an agent wiring an application up.

## Run it for real

[docs/deploy.md](docs/deploy.md) is the install guide: the two images CI publishes (`ghcr.io/samchristensen/kerby` and
`kerby-console`, for amd64 and arm64), a Compose snippet for another project, one container per role to scale each on its
own, the Railway recipe, every setting, backups and alerts.

## Have an agent do it

Give an agent these URLs (raw Markdown; `main` is the newest merge, so put a tag or commit in its place to pin them):

- deploy: <https://raw.githubusercontent.com/samchristensen/kerby/main/docs/deploy.md>
- wire an application up: <https://raw.githubusercontent.com/samchristensen/kerby/main/packages/sdk/INTEGRATION.md>

For example: _"Deploy Kerby beside this project with Docker Compose, following the deploy URL exactly, then integrate it
into the app following the integration URL. Ask me which model provider to use and for its key."_

## Where to read

| File                               | For                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layers, services, tenancy, the turn lifecycle: read before changing code. |
| [docs/README.md](docs/README.md)   | The index of everything else: principles, decisions (ADRs), plans.        |
| [AGENTS.md](AGENTS.md)             | How work is done here: the loop, the invariants, what "done" means.       |
| [SECURITY.md](SECURITY.md)         | Reporting a vulnerability.                                                |

Development is `make setup`, then `make check` and `make test`.

## License

[MIT](LICENSE).
