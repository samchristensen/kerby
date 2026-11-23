# Competitive landscape: agent runtime as a service

Researched 2026-11-23 from primary sources (vendor docs, pricing pages, changelogs) unless marked _secondary_. This market
moves monthly: re-check a claim before a pricing or roadmap decision rests on it. Checked by hand beyond the research
agents: OpenAI's [deprecations table](https://developers.openai.com/api/docs/deprecations), Anthropic's
[self-hosted Managed Agents page](https://platform.claude.com/docs/en/managed-agents/self-hosted.md), Cadenya's
[pricing](https://cadenya.com/pricing). Per-player detail and every source are in the appendices.

## Bottom line

- **The hosted agent loop became a commodity in 2026.** Every model vendor shipped one this year: Anthropic Claude
  Managed Agents (beta 2026-04-08), AWS AgentCore harness (preview 2026-04-22, GA mid-2026), OpenAI Agents API (public
  beta 2026-09-10), Gemini API managed agents, Microsoft Foundry's Copilot harness (preview, Ignite 2026-11). Runtime fees
  are near zero: Anthropic charges $0.08 per running session-hour plus tokens; OpenAI and Foundry prompt agents charge
  nothing beyond model and tool usage. "We run the loop" does not sell on its own.
- **Kerby's defensible shape is the combination, which nobody offers whole**: provider-neutral BYOK, no tenant code
  (configuration plus MCP URLs), exactly-once tool calls, a prompt registry with labels and a Studio bound to the runtime,
  a database per tenant with export, transcripts browsable by end user. Vendor runtimes are locked to one model vendor
  (OpenAI, Anthropic, Gemini) or one cloud (AWS, Azure, Google); framework platforms make the customer deploy code.
- **Closest direct competitors**: Cadenya (same shape, a startup, $49/month); Anthropic Claude Managed Agents (same
  shape, Claude only; its self-hosted edition, released 2026-11-12, is Kerby's architecture: an API server running the
  loop on PostgreSQL 16+ with workers polling for work); OpenAI Agents API; AWS AgentCore harness; LangSmith Agent Server
  with Managed Deep Agents.
- **Prompt management: model vendors are leaving it and LLMOps tools have commoditized it.** OpenAI shuts `/v1/prompts`
  on 2026-11-30 ("move prompt content into your application code"); Anthropic retired Workbench's saved prompts and
  versions on 2026-08-17; Microsoft Prompt Flow retires 2027-04-20; Humanloop shut down 2025-09-08; Latitude removed its
  prompt manager 2026-10-30. Where it survives (Langfuse, LangSmith, Braintrust, PromptLayer, Portkey, Arize, Mistral
  Studio, Bedrock) the model is Kerby's: immutable versions, movable labels, `{{variables}}`. That model is table stakes.
  What is Kerby's own is that the runtime resolves it: no SDK cache to go stale, and the conversation records
  `name@version`.
- **Querying chat history is Kerby's largest gap, and the largest hole among runtimes.** No hosted runtime documents
  search over transcripts: OpenAI's Conversations API cannot list conversations, Anthropic lists sessions by agent and
  date, Google lists by `user_id`. Search lives in observability tools beside the app (Langfuse full-text, LangSmith
  Insights clustering, Braintrust SQL and Topics, Latitude semantic search, Arize Signal) and in Letta's cloud-only hybrid
  message search. Search and insights over the transcripts Kerby already owns would put it ahead of every runtime.
- **Decision models are no longer unique.** OpenAI Decisions API (GA 2026-10-22), Gemini Decision 1, Portkey
  `/v1/decisions` (with a "Jev shape" for TypeSafe), Composio Firewall ("decision models" on tool calls), Cadenya Auto
  mode (Typesafe.ai). Kerby's edge is placement, not the primitive: judged inside the turn, before a tool runs, fail
  closed, on the tenant's own key.

## Who is in the space

| Group                                   | Players                                                                                                                                                                                                   | Relation to Kerby                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Model-vendor and hyperscaler runtimes   | Anthropic Managed Agents, OpenAI Agents API, AWS AgentCore, Google Gemini Enterprise Agent Platform (ex-Vertex), Microsoft Foundry Agent Service                                                          | Head-on. Bundled with model spend or a cloud account; locked to one vendor or cloud                  |
| Configuration-only startups             | Cadenya; Agenta (since 2026-07, aimed at teams' own work); Letta Cloud (partly, now centred on Letta Code)                                                                                                | Head-on, same shape                                                                                  |
| Framework platforms (deploy your code)  | LangSmith Agent Server, Mastra Platform, CrewAI AMP, Agno AgentOS, Vercel Workflows and eve, Cloudflare Agents SDK, Trigger.dev, Convex Agent                                                             | The "build it ourselves" alternative                                                                 |
| Durable-execution primitives            | Temporal, Inngest, Restate, DBOS                                                                                                                                                                          | Substitutes for Absurd inside Kerby, not for Kerby                                                   |
| Prompt management and LLM observability | Langfuse (ClickHouse), LangSmith, Braintrust, PromptLayer, Portkey (Palo Alto Networks), Arize, Helicone (maintenance mode), Latitude                                                                     | Sit beside the app. Ahead on history search and evals; PromptLayer also runs remote MCP tool loops   |
| Adjacent layers                         | Memory: Zep, Mem0, Supermemory. Tool auth: Composio, Arcade, Pipedream (Workday), Nango, Merge. Sandboxes: E2B, Daytona, Modal. Business platforms: Dust, Botpress, Voiceflow, Relevance, Sierra, Decagon | Complements and likely partners. Dust is the nearest business platform (seat-priced, models bundled) |

## Feature matrix

Y yes, P partial, N no, ? unverified. "Config only": the vendor runs the loop from configuration; the customer deploys
no code.

|                          | Config only               | Durable turn          | Conversations API  | List by end user    | History search          | Prompt versions + labels      | Remote MCP | Multi-provider BYOK | Isolation / self-host             |
| ------------------------ | ------------------------- | --------------------- | ------------------ | ------------------- | ----------------------- | ----------------------------- | ---------- | ------------------- | --------------------------------- |
| **Kerby**                | Y                         | Y, exactly-once tools | Y                  | Y                   | N                       | Y                             | Y          | Y                   | Database per tenant; no self-host |
| Anthropic Managed Agents | Y                         | Y, tool semantics ?   | Y                  | N                   | N                       | P (agent versions, no labels) | Y          | N (Claude)          | Self-hosted edition               |
| OpenAI Agents API        | Y                         | Y, tool semantics ?   | Y                  | N                   | N                       | N (shut 2026-11-30)           | Y          | N (OpenAI)          | Regions; not ZDR-eligible         |
| AWS AgentCore harness    | Y                         | P                     | P (memory events)  | P                   | P                       | Y (Bedrock; labels ?)         | Y          | Y                   | Customer's AWS account            |
| Google Agent Platform    | P (Gemini managed agents) | P                     | Y                  | Y                   | N                       | P                             | Y          | P                   | Regions, CMEK, VPC-SC             |
| Microsoft Foundry        | Y (prompt agents)         | P (at-least-once)     | Y                  | ?                   | N                       | P                             | Y          | P (catalog)         | BYO Cosmos DB, VNet               |
| Cadenya                  | Y                         | Y                     | Y                  | Y (tenant, subject) | P                       | P (variations)                | Y          | Y                   | Workspaces; logs kept 14 days     |
| LangSmith Agent Server   | P (Managed Deep Agents)   | Y                     | Y                  | P (metadata)        | Y (in LangSmith)        | Y                             | Y          | Y                   | Hybrid, self-host (Enterprise)    |
| Letta Cloud              | Y                         | P                     | Y                  | ?                   | Y (hybrid, cloud only)  | N                             | Y          | Y                   | Self-host                         |
| Mastra Platform          | N                         | P (beta)              | Y                  | Y (`resourceId`)    | P                       | P (draft/published)           | Y          | Y                   | Self-host; us/eu regions          |
| Cloudflare Agents SDK    | N                         | Y                     | Y (per agent)      | N                   | P (per-agent full-text) | N                             | Y          | Y                   | A toolkit you assemble            |
| PromptLayer              | P (MCP loop, workflows)   | ?                     | N                  | N                   | Y                       | Y (plus A/B labels)           | Y          | Y                   | Enterprise self-host              |
| Langfuse                 | N                         | N                     | P (sessions, read) | Y                   | Y (full-text)           | Y                             | N          | P (gateway beta)    | MIT self-host                     |

## Pricing anchors

For plan 0001's open pricing question (M9).

| Player                   | What is charged            | Published numbers                                               |
| ------------------------ | -------------------------- | --------------------------------------------------------------- |
| Anthropic Managed Agents | tokens + runtime           | $0.08 per session-hour while running                            |
| OpenAI Agents API        | tokens + tools             | no runtime fee                                                  |
| Microsoft Foundry        | models + tools             | prompt agents free; hosted agents $0.0994/vCPU-h, $0.0118/GiB-h |
| AWS AgentCore            | metered primitives         | runtime $0.1276/vCPU-h + $0.0169/GB-h; memory $1/GB ingested    |
| Cadenya                  | platform + per LLM request | $0; $49/month with 50k requests, then $0.0015 each              |
| LangSmith                | seats + usage units        | $39/seat/month; $1 per LSU                                      |
| Letta                    | subscription + credits     | $0; $20/month Pro                                               |
| Mastra Platform          | workspace + compute        | $0 / $25 / $250 per month                                       |
| Langfuse Cloud           | traces and observations    | $29 / $199 / $2,499 per month; $8 per 100k units over           |
| PromptLayer              | requests                   | $49 / $500 per month                                            |
| Agenta                   | credits                    | $29 / $299 per month                                            |
| Zep                      | ingestion credits          | $125/month (50k credits) / $375/month (200k)                    |

The vendors give the runtime away against model spend. The startups charge a platform fee plus usage per LLM request,
trace or credit. Under BYOK Kerby's own costs are compute and storage, not tokens, so a fee per turn or per LLM request
(Cadenya's unit) tracks cost.

## Where Kerby differs

- **A provider-neutral BYOK runtime.** Only AWS AgentCore accepts several providers' keys, and it needs an AWS account.
- **Exactly-once tool calls as a stated guarantee.** None of the hosted runtimes reviewed documents tool-call semantics;
  Foundry documents that recovery reruns the handler (at-least-once).
- **Isolation.** OpenAI keeps `/v1/agents` and `/v1/conversations` data until deleted and not ZDR-eligible; Anthropic's
  hosted Managed Agents are not ZDR- or HIPAA-eligible; no framework platform offers a database per end customer. Kerby:
  a database per tenant, `pg_dump` export, deletion.
- **A prompt registry bound to the runtime**, while OpenAI and Anthropic drop theirs.
- **Transcripts by end user in a console.** Among runtimes only Google lists sessions by `user_id`.

## Gaps against the market

Ordered by how many competitors have it and how close it sits to Kerby's buyer.

1. **History search and insights**: full-text, semantic, clustering (Langfuse, LangSmith, Braintrust, Latitude, Letta,
   Arize). Specifications to learn from: Latitude's semantic plus exact search; LangSmith Insights (summarize and
   categorize conversations on the customer's model keys, which fits BYOK).
2. **Per-end-user tool auth.** Composio, Arcade, Pipedream, Nango, Merge and AgentCore Identity key credentials to an
   end-user id and run the OAuth consent. Plan 0001 M7 stores one auth per MCP server per tenant: either give the
   registry an end-user dimension, or document plugging Composio or Arcade in as an MCP server.
3. **Sandboxes and code execution.** Every vendor runtime ships one. Kerby's no-tenant-code rule rules out hosting them;
   partners exist (E2B, Daytona and Modal are environments for OpenAI's Agents API).
4. **Long-term memory across conversations**: Letta, Zep, Mem0, AgentCore Memory, Google Memory Bank, Claude memory
   stores.
5. **Evals, datasets, A/B traffic on labels**: PromptLayer dynamic release labels, Braintrust, LangSmith.
6. **Schedules, webhooks, an embeddable chat widget**: Anthropic scheduled deployments, OpenAI scheduled automations,
   Cadenya widgets, OpenAI ChatKit.
7. **Self-host or BYOC** for enterprises: Anthropic self-hosted Managed Agents, LangSmith hybrid, Agno, Letta, Langfuse.

## Threats and openings

- **Price compression**: vendors bundle the loop with model spend.
- **Anthropic self-hosted Managed Agents** is the same architecture, sold by the model vendor's enterprise team.
- **Building it yourself got easier for TypeScript teams**: Vercel eve 1.0 (GA 2026-11-17), Cloudflare Agents SDK (it
  ships a Pi harness, Kerby's harness), Trigger.dev `chat.agent`, Mastra.
- **Opening: prompt refugees.** OpenAI prompt-object users (shutdown 2026-11-30) and former Workbench users need a home.
  Kerby's prompt routes (`GET /v1/prompts/:name/versions/:version`, `POST .../render`) serve an app that runs no turns on
  Kerby, so they can be an entry point.
- **Opening: consolidation leaves migration pools**: Humanloop (gone), Helicone (maintenance mode under Mintlify),
  Latitude V1 prompts (gone), Smithery hosting (shut 2026-10-31, absorbed by Arcade), Vellum (pivoted).
- **Signal**: Latitude walked away from serving prompts on the critical path while Agenta moved toward running agents.
  Prompts alone are a weak product; prompts inside a runtime is where the market is going.

## Appendices

Each appendix is a research agent's segment report as written, sources inline. Axes everywhere: hosted runtime, durable
execution, conversations API, history query, prompt management, tools and MCP, BYOK, isolation and self-host, console.

- [A. Model vendors and hyperscalers](#appendix-a-model-vendors-and-hyperscalers)
- [B. Framework platforms and durable execution](#appendix-b-framework-platforms-and-durable-execution)
- [C. Prompt management and observability](#appendix-c-prompt-management-and-observability)
- [D. Adjacent layers: memory, tool auth, sandboxes, business platforms](#appendix-d-adjacent-layers-memory-tool-auth-sandboxes-business-platforms)

## Appendix A: Model vendors and hyperscalers

_Report title: Segment: model vendors & hyperscalers with hosted agent runtimes / stateful agent APIs_

Research date 2026-11-23. Sources are first-party unless marked _(secondary)_. "Kerby" = hosted, multi-tenant, BYOK, MCP-only tools, harness-agnostic agent runtime with stored transcripts, versioned prompts and decision guardrails.

### Segment summary

- **Every model vendor now sells a hosted agent loop, and all launched in 2026.** Anthropic Claude Managed Agents (beta, 2026-04-08), OpenAI Agents API (public beta, 2026-09-10), AWS AgentCore harness (preview 2026-04-22, GA June 2026), Microsoft Foundry "Copilot harness" prompt agents (preview, Ignite Nov 2026), Gemini API managed agents (Antigravity agent). All follow the same model: agent config + session + event stream + sandbox. This category did not exist when Kerby was conceived. It is now the default offering.
- **Their default workload is a sandboxed coding/computer agent, not a chat agent.** The Codex harness (OpenAI, Bedrock Managed Agents), the Claude Code harness (Anthropic) and Antigravity (Google) all center on a container with bash and files. Kerby's chat-plus-MCP profile is the lighter case. None of them needs Kerby's "no tenant code" stance, because each one hosts sandboxes.
- **They are single-vendor on models, except the hyperscalers.** OpenAI's Agents API uses OpenAI inference only. Anthropic Managed Agents is Claude-only (self-hosted MA can route Claude to Bedrock, Vertex, Foundry or a gateway). AWS AgentCore harness accepts Bedrock, OpenAI, Gemini or LiteLLM keys. Foundry uses its own model catalog. Kerby's BYOK and multi-provider stance is matched only by AWS AgentCore, plus Cloudflare as a DIY option.
- **Vendors are leaving prompt management.** OpenAI shuts down `/v1/prompts` and reusable prompt objects, Agent Builder and Evals on **2026-11-30**, with "move prompts into code" as the stated replacement. Anthropic retired Workbench (saved prompts, versions, evals) on **2026-08-17**; the Playground that replaced it stores nothing. Microsoft Prompt Flow stops feature work and retires on **2027-04-20**. Remaining first-party prompt registries: AWS Bedrock Prompt Management, Google Agent Platform prompt classes, and Mistral Studio (Jul 2026, versioned prompts with label promotion). A versioned prompt store with labels, variables and a WYSIWYG editor tied to the runtime is now a gap the model vendors left open, so Kerby's Studio is better differentiated than it was a year ago.
- **Conversation history browsing is thin at every vendor.** OpenAI Conversations API has create, retrieve, update, delete and list items, but no list-conversations endpoint. Agents API sessions list by project only (limit, order, cursor). Anthropic sessions list filters on `agent_id` and `created_at`. Google Agent Platform Sessions is the only one with list-by-`user_id`, plus orderBy and a TTL (365-day default). No vendor documents full-text or semantic search over transcripts. Exception: Cloudflare's experimental `Sessions` capability has full-text search, but it is DIY per Durable Object. Kerby's "browse by `externalUserId`" puts it level with Google here, not ahead.
- **Typed "decision" judgments are now a vendor API.** OpenAI Decisions API (GA 2026-10-22; predicate probability, choice, score; evaluates conversations including tool calls) and the Gemini Decisions API (Gemini Decision 1) both directly overlap Kerby's "decision models" guardrails. AgentCore Policy (Cedar on tool calls) and Anthropic's `auto` permission policy cover the tool-call-guardrail half.
- **Data residency and isolation:** vendor-hosted runtimes are mostly not eligible for zero data retention. Anthropic MA is not ZDR- or HIPAA-eligible, except self-hosted. OpenAI `/v1/agents` and `/v1/conversations` keep data "until deleted" and are not ZDR-eligible. The answer for strict tenants is a self-hosted or in-your-cloud variant: Anthropic self-hosted MA (Postgres-backed, released 2026-11-12), Foundry BYO Cosmos DB, AgentCore in your AWS account. Kerby's database per tenant plus pg_dump export is a real differentiator against OpenAI and Anthropic hosted, but not against hyperscalers, where everything already sits in the customer's own account.
- **Closest to Kerby, ranked:**
  1. **Anthropic Claude Managed Agents.** Same shape: agent config versioned 1..N, sessions, an SSE event stream with full event history, remote MCP servers with vault credentials, a Console agent builder and session viewer. Self-hosted MA is architecturally Kerby-like: an API server running the agent loop on PostgreSQL ≥16, with workers polling for work. Differences from Kerby: Claude-only, sandbox-centric, no prompt registry or labels.
  2. **OpenAI Agents API.** Same managed-loop, sessions and events model. OpenAI-models-only. Prompt objects are being killed.
  3. **AWS AgentCore harness.** Config-defined agent, multi-provider BYOK, Memory, Gateway (MCP), Policy. Lives in the tenant's AWS account. Heavier, AWS-only, and the console is aimed at developers.
  4. **Foundry prompt agents + conversations.** Free runtime, versioned agents. Azure-only, Foundry model catalog.
- **Kerby's whitespace in this segment:** a provider-neutral hosted runtime (BYOK across OpenAI, Anthropic and others) with exactly-once tool execution, a first-class prompt registry with labels and a WYSIWYG Studio that the vendors are abandoning, per-tenant database isolation with export, and an end-user-keyed transcript browser. The main risk is that "hosted loop" is becoming a free or cheap add-on to model spend ($0.08/session-hour at Anthropic; no runtime fee at OpenAI or Foundry), so Kerby cannot charge for the loop alone.

---

### OpenAI: Responses + Conversations, Agents API, Agents SDK, AgentKit, Prompts, Decisions

**What and status.** The OpenAI platform API:
- Responses API: the core primitive.
- Conversations API: stored conversation objects.
- **Agents API**: hosted Codex harness, public beta since 2026-09-10 ([changelog](https://developers.openai.com/api/docs/changelog)).
- Agents SDK: open-source library.
- AgentKit (Oct 2025): Agent Builder, ChatKit, Connector Registry.
- Decisions API: GA 2026-10-22.

The Assistants API **shut down 2026-08-26**; the listed replacement is Responses + Conversations ([deprecations](https://developers.openai.com/api/docs/deprecations)).

Deprecated with shutdown on **2026-11-30** (notice 2026-06-03; [deprecations](https://developers.openai.com/api/docs/deprecations), [AgentKit post update](https://openai.com/index/introducing-agentkit/)):
- `/v1/prompts` and reusable prompt objects. Replacement: "Move prompt content into your application code."
- Agent Builder. Replacement: Agents SDK or ChatGPT Workspace Agents. "ChatKit remains available."
- Evals dashboard and API. Replacement: Promptfoo.

**Agents API details.** OpenAI "manages sessions, orchestration, context compaction, and recovery while your application provides tools and chooses its execution environment" ([overview](https://developers.openai.com/api/docs/guides/agents-api/overview.md)).
- Concepts: Agent (model, instructions, tools, MCP servers), Environment (OpenAI-hosted, self-hosted or partner sandbox: Modal, Daytona, E2B, Cloudflare, AWS Lambda MicroVM and others), Session ("durable instance of an agent"), Events/items.
- Features: streaming plus webhooks, steering mid-turn, subagents, scheduled automations (added 2026-10-23), auto-review of tool calls (added 2026-10-30), computer use (added 2026-09-29) ([changelog](https://developers.openai.com/api/docs/changelog)).
- Sessions can be listed per project (limit, order, `after` cursor), retrieved, and deleted. Items and turns can be fetched for saved history ([manage sessions](https://developers.openai.com/api/docs/guides/agents-api/sessions/manage.md), [events](https://developers.openai.com/api/docs/guides/agents-api/sessions/events.md)). No per-end-user filter is documented.

**Conversations API.** Endpoints are create, retrieve, update, delete and items.list. There is no list-all-conversations endpoint ([reference index](https://developers.openai.com/api/reference/llms.txt)).

**Data retention and residency.**
- `/v1/conversations` and `/v1/agents` application state: "Until deleted", **not ZDR-eligible**.
- `/v1/responses`: 30-day default application-state retention when stored.
- Source for the above: [data controls](https://developers.openai.com/api/docs/guides/your-data.md).
- Regional projects: US, EU, AU, IN, JP domain prefixes. The region is fixed at project creation ([data residency](https://developers.openai.com/api/docs/guides/data-residency.md)).

**MCP.** Remote MCP tool in Responses, plus "Secure MCP Tunnel" for private or on-prem MCP servers; MCP in Agents API sessions ([docs index](https://developers.openai.com/api/docs/llms.txt)).

**Overlap with Kerby.**

| Axis                          | Overlap                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hosted runtime                | **Yes** (Agents API beta)                                                                                                                                                |
| Durable/resumable             | **Yes**: "recovery", "resuming a session where it left off". Tool-call exactly-once semantics not documented (unverified)                                                |
| Stored conversations API      | **Yes** (Conversations; Agents API sessions/items)                                                                                                                       |
| Querying history              | **Partial**: list sessions per project, paginate items. No per-user filter, no search                                                                                    |
| Prompt management             | **Being removed** 2026-11-30 (had id/version/variables + dashboard)                                                                                                      |
| Tools/MCP                     | **Yes**                                                                                                                                                                  |
| BYOK/model choice             | **No**: OpenAI inference only. The Agents SDK is provider-agnostic but self-run ([models and providers](https://developers.openai.com/api/docs/guides/agents/models.md)) |
| Isolation/residency/self-host | **Partial**: regional projects. Agents and Conversations not ZDR-eligible. Self-hosted sandbox only, not a self-hosted service                                           |
| Console for non-engineers     | **Shrinking**: Agent Builder and prompt dashboard die 2026-11-30. ChatKit is an embeddable chat UI                                                                       |

**Pricing.** Agents API: model tokens at API rates, tools at standard rates, OpenAI-hosted sandboxes at container rates. No runtime fee ([overview](https://developers.openai.com/api/docs/guides/agents-api/overview.md)). AgentKit: "included with standard API model pricing" ([AgentKit post](https://openai.com/index/introducing-agentkit/)).

**What it has that Kerby lacks.**
- Hosted code sandboxes, computer use, subagents, scheduled automations, compaction.
- Decisions API (`POST /v1/decisions`, gpt-6-luna; predicate, choice and score with probabilities; evaluates conversation history including tool calls; up to 400 questions per request; Playground) ([decisions guide](https://developers.openai.com/api/docs/guides/decisions.md)). This is a direct analogue of Kerby's decision models.

**Where Kerby differs.** Multi-provider BYOK; a prompt registry with labels at the moment OpenAI is exiting it (a migration target for 2026-11-30 refugees); per-tenant database and export; listing by end user.

---

### Anthropic: Claude Managed Agents, Agent SDK, Console/Playground, MCP connector, Files/Memory; Humanloop

**What and status.**
- **Claude Managed Agents (MA)**: beta, launched 2026-04-08, header `managed-agents-2026-04-01`, "enabled by default for all API accounts". Available on Claude API, Claude Platform on AWS and Claude on Google Cloud ([release notes](https://platform.claude.com/docs/en/release-notes/overview.md), [overview](https://platform.claude.com/docs/en/managed-agents/overview.md)).
- **Self-hosted Claude Managed Agents**: launched 2026-11-12, access via account team ([release notes](https://platform.claude.com/docs/en/release-notes/overview.md)).
- Claude Agent SDK: a library that "runs the Claude Code binary" in your process ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview.md)).

**MA details.**
- Concepts: Agent (model, system prompt, tools, MCP servers, skills), Environment (Anthropic cloud sandbox or self-hosted sandbox), Session, Events. SSE streaming; "the Managed Agents service keeps the event history, and you can fetch it in full" ([overview](https://platform.claude.com/docs/en/managed-agents/overview.md)).
- Agents are versioned: `version` starts at 1 and increments on change, with optimistic concurrency (409) ([agent setup](https://platform.claude.com/docs/en/managed-agents/agent-setup.md)).
- Sessions list filters by `agent_id` and `created_at`; sessions can be archived or deleted ([session operations](https://platform.claude.com/docs/en/managed-agents/session-operations.md)).
- Also listed in the docs: memory stores, "Dreams" memory consolidation (research preview), vaults for credentials, webhooks, scheduled deployments, session budgets, multi-agent and dynamic workflows, permission policies including `auto` (server evaluates each tool call) ([llms index](https://platform.claude.com/llms.txt), [release notes](https://platform.claude.com/docs/en/release-notes/overview.md)).
- OpenTelemetry export (beta, 2026-10-14). `ant apply` keeps resources as code ([release notes](https://platform.claude.com/docs/en/release-notes/overview.md)).
- Console has a visual agent builder: model, prompt, MCP by URL, tools, skills ([Build in Console](https://platform.claude.com/docs/en/managed-agents/onboarding.md)). It also has a session viewer ([release notes, 2026-09-10](https://platform.claude.com/docs/en/release-notes/overview.md)).

**Self-hosted MA.** You host:
- `cma-server`, which serves the API, runs the agent loop, and stores agents, sessions and history.
- A **PostgreSQL 16+** database.
- Workers that poll for work.
- A console behind your IdP.

Inference goes to the Claude API, Bedrock, Google Cloud, Microsoft Foundry or your own gateway. Each trust level needs its own deployment for multitenancy ([self-hosted](https://platform.claude.com/docs/en/managed-agents/self-hosted.md)).

**Console prompt tooling.** Workbench is retired; it became "playground" on 2026-08-18 ([release notes](https://platform.claude.com/docs/en/release-notes/overview.md)). Playground "doesn't support saving prompt history or evaluating prompts… Saved prompts, prompt versions, evals, and prompt sharing aren't part of the playground" ([help center, 2026-10-19](https://support.claude.com/en/articles/8606378-how-do-i-use-the-workbench)). Secondary reports say the `generate_prompt`, `improve_prompt` and `templatize_prompt` endpoints were also retired ([TechTimes](https://www.techtimes.com/articles/324669/20260817/anthropic-kills-claude-workbench-today-saved-prompts-gone-api-pipelines-broken.htm)) _(secondary)_.

**MCP connector, Files, Memory.**
- MCP connector in the Messages API is beta (`mcp-client-2026-09-15`), with OAuth bearer tokens ([MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector.md)).
- Files API left beta on 2026-08-19 ([release notes](https://platform.claude.com/docs/en/release-notes/overview.md)).
- Memory tool and MA memory stores exist ([llms index](https://platform.claude.com/llms.txt)).

**Humanloop.**
- Anthropic acquired Humanloop's founders and team in Aug 2025 ([TechCrunch](https://techcrunch.com/2025/08/13/anthropic-nabs-humanloop-team-as-competition-for-enterprise-ai-talent-heats-up)) _(secondary)_. IP was reportedly not part of the deal ([Seedtable](https://seedtable.com/exits/humanloop)) _(secondary, unverified)_.
- Humanloop's own page: "Following our acquisition, the Humanloop platform will be sunset on September 8th, 2025". All data deleted; billing stopped 2025-07-30; it recommends Langfuse and Braintrust ([Humanloop migration guide](https://humanloop.com/docs/guides/migrating-from-humanloop)).
- No Humanloop-derived prompt-versioning product survives at Anthropic. Workbench's saved prompts and versions were retired in Aug 2026 (see above).

**Overlap with Kerby.**

| Axis                          | Overlap                                                                                                                                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosted runtime                | **Yes**                                                                                                                                                                                                                      |
| Durable/resumable             | **Yes**: "sessions are long-running, resume cleanly after pauses". Exactly-once tool semantics not documented (unverified)                                                                                                   |
| Stored threads API            | **Yes** (sessions + full event history)                                                                                                                                                                                      |
| Querying history              | **Partial**: list by agent and created_at, retrieve events. No end-user filter or search documented                                                                                                                          |
| Prompt management             | **Partial**: agent configs versioned 1..N. No labels/environments, no variables, no prompt registry. Playground is stateless                                                                                                 |
| Tools/MCP                     | **Yes** (MCP by URL, vaults, MCP tunnels in research preview)                                                                                                                                                                |
| BYOK/model choice             | **No** on hosted (Claude only). Self-hosted can route Claude via other clouds                                                                                                                                                |
| Isolation/residency/self-host | **Partial→Yes**: `inference_geo` pin per agent or session ([data residency](https://platform.claude.com/docs/en/manage-claude/data-residency.md)). Hosted MA not ZDR- or HIPAA-eligible. Self-hosted MA on your own Postgres |
| Console                       | **Yes** (agent builder, session viewer)                                                                                                                                                                                      |

**Pricing.** Tokens at model rates plus **$0.08 per session-hour**, counted only while the session status is `running`. Idle time is free. Session runtime replaces container-hour billing. Self-hosted MA: contact sales ([pricing](https://platform.claude.com/docs/en/about-claude/pricing.md)).

**What it has that Kerby lacks.** Cloud sandboxes (bash and files), skills, memory stores and Dreams, scheduled deployments, multi-agent workflows, a self-hosted distribution, budgets, OTel.

**Where Kerby differs.** Model-neutral BYOK; a prompt registry with labels and variables (Anthropic removed theirs); decision-model guardrails; listing by end user; per-tenant database. Note that self-hosted MA is almost exactly Kerby's architecture (Postgres plus polling workers). That is evidence the design is sound, and a competitive threat for enterprise tenants who want to self-host.

---

### AWS: Bedrock AgentCore (Runtime, harness, Memory, Gateway, Identity, Observability, Policy), Bedrock Managed Agents (OpenAI), Bedrock Agents Classic, Prompt Management

**What and status.**

_AgentCore_ is a modular agent platform ([pricing](https://aws.amazon.com/bedrock/agentcore/pricing/)):
- **Runtime**: you bring agent code in a container or as code; there are serverless microVM and EC2 Instances variants.
- **Harness**: config-based managed agent loop. Preview 2026-04-22 ([What's New](https://aws.amazon.com/about-aws/whats-new/2026/04/agentcore-new-features-to-build-agents-faster/)); **GA** announced at AWS Summit NY 2026 ([AWS blog](https://aws.amazon.com/blogs/aws/top-announcements-of-the-aws-summit-in-new-york-2026/)).
- Memory, Gateway, Identity, Policy, Observability, Evaluations, Optimization, Agent Registry, Browser, Code Interpreter, Web Search, Payments.

_Bedrock Managed Agents, powered by OpenAI_: preview. "Combines OpenAI models with the Codex harness and Amazon Bedrock AgentCore… The agent runtime and model inference remain inside AWS" ([AWS page](https://aws.amazon.com/bedrock/managed-agents-openai/)). Launched in limited preview with OpenAI-on-Bedrock ([About Amazon](https://www.aboutamazon.com/news/aws/bedrock-openai-models)). It is an adaptation of OpenAI's Agents API, authenticated with IAM/SigV4 ([OpenAI docs](https://developers.openai.com/api/docs/guides/agents-api/bedrock-managed-agents.md)).

_Bedrock Agents_ (2023) is now "Agents Classic", in maintenance mode, closed to new customers from 2026-07-30, with the model catalog frozen ([AWS docs](https://docs.aws.amazon.com/bedrock/latest/userguide/agents-classic-maintenance-mode.html)).

**Runtime details.**
- Sessions run in a dedicated microVM for up to 8 hours, with a 15-minute idle termination. A new microVM is created after termination ([how it works](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-how-it-works.html)).
- Protocols: HTTP, MCP, A2A. Runtimes are versioned with endpoints (same source).
- Instances variant: sessions persist up to 14 days ([pricing](https://aws.amazon.com/bedrock/agentcore/pricing/)).

**Harness details.**
- Defines model, system prompt, tools, skills, memory and limits in config, with per-invocation overrides.
- Each session gets a microVM with filesystem and shell.
- Filesystem persistence (preview) lets an agent "suspend mid-task and resume".
- Can export to Strands code.
- Sources: [What's New](https://aws.amazon.com/about-aws/whats-new/2026/04/agentcore-new-features-to-build-agents-faster/), [harness models](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-models.html).

**Memory.** Short-term memory stores events per session; long-term memory uses strategies (semantic, user-preference, episodic) organized into namespaces ([terminology](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-terminology.html)).

**Prompt Management.** Draft plus immutable versions, variables, variants for comparison, and a console test UI ([prompt management](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-management.html), [deploy with versions](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-management-deploy.html)). Aliases or labels are not documented on those pages (unverified). AgentCore Optimization "Recommendations" generates optimized system prompts and tool descriptions; Experiments runs A/B tests on live traffic ([pricing](https://aws.amazon.com/bedrock/agentcore/pricing/)).

**Overlap with Kerby.**

| Axis                     | Overlap                                                                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosted runtime           | **Yes** (harness GA; Runtime hosts your code)                                                                                                                                                                   |
| Durable/resumable        | **Partial**: session state in microVM up to 8h; filesystem persistence in preview. No exactly-once tool guarantee documented                                                                                    |
| Stored conversations API | **Partial**: Memory short-term events (by actor and session) rather than a threads API                                                                                                                          |
| Querying history         | **Partial**: Memory retrieval, long-term semantic retrieval of extracted memories, CloudWatch traces, Optimization "Insights" across sessions. No transcript browser                                            |
| Prompt management        | **Yes** (Bedrock Prompt Management: versions, variants, variables) plus AgentCore prompt recommendations                                                                                                        |
| Tools/MCP                | **Yes** (Gateway turns APIs/Lambda into MCP; MCP server hosting; Registry)                                                                                                                                      |
| BYOK/model choice        | **Yes**: harness supports Bedrock, OpenAI, Gemini or any LiteLLM provider via API-key credential provider ([harness models](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-models.html)) |
| Isolation/residency      | **Yes**: runs in the customer's AWS account and region, IAM, VPC                                                                                                                                                |
| Console                  | **Partial**: AWS console and CLI, developer-centric                                                                                                                                                             |

**Pricing** ([pricing](https://aws.amazon.com/bedrock/agentcore/pricing/)):
- Runtime microVM v2: $0.1276 per vCPU-hour and $0.0169 per GB-hour on consumption (v1: $0.0895 and $0.00945). CPU is not billed during I/O wait.
- Gateway: $0.005 per 1k invocations, $0.025 per 1k searches.
- Identity: free via Runtime or Gateway, otherwise $0.010 per 1k tokens.
- Memory short-term: $1/GB ingested, $0.20/GB retrieved, $0.10/GB-month stored.
- Memory long-term: $0.75 per 1k records/month (built-in strategies), $0.50 per 1k retrievals.
- Policy: $0.000025 per authorization request.
- Evaluations: $0.0024/$0.012 per 1k input/output tokens.
- Observability: billed at CloudWatch rates.

**What it has that Kerby lacks.** Policy (Cedar) on tool calls, Evaluations, Optimization and A/B testing, Identity (OAuth on behalf of users), Browser and Code Interpreter, Agent Registry, payments, in-account deployment.

**Where Kerby differs.**
- Kerby is a single HTTP API with a stored-transcript model and prompt labels, versus AgentCore's dozen metered primitives.
- Kerby is cloud-neutral and suits small tenants, versus an AWS account requirement.
- Kerby has a non-engineer Studio, which AgentCore lacks.

---

### Google Cloud: Gemini Enterprise Agent Platform (ex-Vertex AI): Agent Runtime (ex-Agent Engine), Sessions, Memory Bank, ADK, prompt management; Gemini API Interactions + managed agents

**What and status.**
- Vertex AI was rebranded as **Gemini Enterprise Agent Platform** on 2026-04-22. "All Vertex AI services and roadmap evolutions will be delivered exclusively through the Agent Platform" ([Google blog](https://cloud.google.com/blog/products/ai-machine-learning/introducing-gemini-enterprise-agent-platform)).
- It includes: Agent Studio (low-code), ADK (code-first), the re-engineered **Agent Runtime** (long-running agents "for days at a time"), Memory Bank, and Agent Identity, Registry and Gateway (same source).
- "Agent Engine" is now called Agent Runtime _(secondary: [addyosmani.com](https://addyosmani.com/agents/12-getting-started-with-vertex-and-adk/))_. Docs still use "Agent Engine instances" in places ([sessions API](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/sessions/manage-with-api)).
- Sessions and Memory Bank are GA ([release notes](https://docs.cloud.google.com/vertex-ai/docs/release-notes)) _(via search snippet)_.

**Sessions.**
- Stores conversation history and state.
- **List sessions filtered by `user_id`**, orderBy `create_time`, `update_time` or `display_name`.
- TTL or `expire_time`, default **365 days**.
- Regional, multi-region (us/eu) or global endpoints; CMEK and VPC-SC.
- Sessions are viewable in the console under Deployments → Sessions tab.
- Source: [manage with API](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/sessions/manage-with-api).

**Memory Bank.** Long-term memories generated from sessions, scoped per user, with revisions and IAM conditions ([Memory Bank overview](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/memory-bank/overview)).

**Prompt management.** `client.prompts.create` and `create_version`; prompts are "assembled and versioned in Agent Studio… or the Agent Platform SDK", with CMEK and VPC-SC ([prompt classes](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/prompt-classes)) _(via search snippet)_. Labels and environments are not verified.

**Gemini API side.**
- **Interactions API** is GA as of June 2026. It stores server-side by default (`previous_interaction_id`). Retention is 55 days on paid tier, configurable to 7, 14, 28 or 55 days, with explicit delete ([interactions](https://ai.google.dev/gemini-api/docs/interactions.md.txt), [overview](https://ai.google.dev/gemini-api/docs/interactions-overview.md.txt)).
- **Managed agents**: extend the "Antigravity" agent with instructions, remote MCP servers, functions and skills, run inline or saved; remote sandbox Environments; server-side Credentials; hooks ([custom agents](https://aistudio.google.com/docs/custom-agents.md), [docs index](https://aistudio.google.com/docs/llms.txt)).
- **Decisions API**: Gemini Decision 1, typed yes/no, choice and score with calibrated probabilities, zero output tokens ([Decisions](https://aistudio.google.com/docs/decisions-api.md)).

**Overlap with Kerby.**

| Axis                     | Overlap                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Hosted runtime           | **Yes**: Agent Runtime hosts your ADK/LangGraph code; Gemini managed agents run the loop for you                                 |
| Durable/resumable        | **Partial**: multi-day agents, Sessions state. Exactly-once tools not documented                                                 |
| Stored conversations API | **Yes** (Sessions; Interactions)                                                                                                 |
| Querying history         | **Yes/partial**: list by `user_id`, orderBy, console Sessions tab. No full-text search documented                                |
| Prompt management        | **Partial**: versioned prompt resources; labels unverified                                                                       |
| Tools/MCP                | **Yes**                                                                                                                          |
| BYOK/model choice        | **Partial**: Model Garden includes Claude, but via Google billing. ADK can call any model; Gemini managed agents are Gemini-only |
| Isolation/residency      | **Yes**: regional and multi-regional, CMEK, VPC-SC                                                                               |
| Console                  | **Yes** (Agent Studio, console)                                                                                                  |

**Pricing** ([Agent Platform pricing](https://cloud.google.com/products/gemini-enterprise-agent-platform/pricing)):
- Agent Compute $0.085/vCPU-h; Agent Memory $0.009/GiB-h; Agent Storage $0.30/GiB-month.
- Sessions and Memory Bank (structure effective 2026-09-01): storage at the Agent Storage rate; reads 1 vCPU-h ($0.085) per 3M; writes 1 vCPU-h per 1M.
- Memory generation and embedding tokens billed separately.

**What it has that Kerby lacks.** Long-term Memory Bank, Agent Gateway/Identity/Registry, Decisions model, sandbox and computer use, CMEK and VPC-SC.

**Where Kerby differs.** Provider-neutral BYOK, a hosted loop with no deploy step, label-based prompt promotion with a WYSIWYG Studio, small-tenant onboarding. Google is the closest on "list conversations by end user". Kerby needs parity here, plus search.

---

### Microsoft: Foundry Agent Service (prompt agents, hosted agents, Copilot harness), Agent Framework, prompt management

**What and status.**
- Foundry Agent Service is GA. It hosts "prompt agents" (declarative, run by Foundry), voice prompt agents and **hosted agents** (your container) ([overview](https://learn.microsoft.com/en-us/azure/foundry/agents/overview)).
- At Ignite (Nov 2026), the **Microsoft Copilot harness** went to public preview: "Microsoft runs the agent loop and sandbox". Also GA at Ignite: long-running hosted-agent resiliency, network egress controls and voice agents ([Ignite 2026 blog](https://devblogs.microsoft.com/foundry/whats-new-in-foundry-agent-service-at-ignite-2026/)).
- Classic agents (threads/runs/messages, Assistants-style) are deprecated and **retire 2027-03-31**. Migration means threads → conversations and runs → responses ([classic what's new](https://learn.microsoft.com/en-us/azure/foundry-classic/agents/whats-new), [migrate](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/migrate)).
- **Microsoft Agent Framework** 1.0 is GA (Apr 2026). It succeeds Semantic Kernel and AutoGen ([MAF Build 2026 blog](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-at-build-2026-announce/)).
- **Prompt Flow**: feature development ended 2026-04-20; retires 2027-04-20; migration path is Agent Framework ([Microsoft Tech Community](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/prompt-flow-is-being-retired/4513587), [promptflow docs](https://microsoft.github.io/promptflow/)).

**Details.**
- The runtime "manages conversations, tool calls, and agent lifecycle".
- Agents are versioned with stable endpoints and published to Teams, Copilot and Entra Agent Registry.
- Toolboxes expose tools via "a single managed MCP endpoint".
- BYO resources: storage, AI Search, **Cosmos DB for conversation state**. Private networking.
- Source for the above: [overview](https://learn.microsoft.com/en-us/azure/foundry/agents/overview).
- Hosted sessions: VM-isolated sandbox; filesystem persisted across turns; deleted after 30 days of inactivity; idle timeout 2–240 minutes ([manage hosted sessions](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/manage-hosted-sessions)).
- Long-running recovery "reruns the handler, so developers should save progress and prevent duplicate side effects", i.e. at-least-once ([Ignite blog](https://devblogs.microsoft.com/foundry/whats-new-in-foundry-agent-service-at-ignite-2026/)).

**Overlap with Kerby.**

| Axis                     | Overlap                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| Hosted runtime           | **Yes** (prompt agents; Copilot harness preview)                                                       |
| Durable/resumable        | **Partial**: recovery reruns the handler (at-least-once); Kerby's exactly-once tool calls are stronger |
| Stored conversations API | **Yes** (service-managed conversations, Responses-compatible)                                          |
| Querying history         | **Partial**: tracing, Insights over traces; no transcript search documented                            |
| Prompt management        | **Partial**: agent versions; Prompt Flow being retired; standalone prompt registry unverified          |
| Tools/MCP                | **Yes** (Toolboxes MCP endpoint, OAuth OBO passthrough)                                                |
| BYOK/model choice        | **Partial**: Foundry model catalog (OpenAI, Llama, DeepSeek and others), not arbitrary tenant keys     |
| Isolation/residency      | **Yes** (VNet, BYO Cosmos DB, Entra RBAC)                                                              |
| Console                  | **Yes** (Foundry portal)                                                                               |

**Pricing.**
- "No additional charge for creating or running Foundry-native agents using prompts and workflows"; models and tools are billed separately ([pricing](https://azure.microsoft.com/en-us/pricing/details/foundry-agent-service/)).
- Hosted agents: $0.0994/vCPU-h and $0.0118/GiB-h.
- Memory: $0.25 per 1k short-term events, $0.25 per 1k long-term memories/month, $0.50 per 1k retrievals.
- Source for hosted-agent and memory rates: [Foundry devblog](https://devblogs.microsoft.com/foundry/from-local-to-production-the-complete-developer-journey-for-building-composing-and-deploying-ai-agents/).
- A Foundry "Decisions API GA" was reported in the Nov 2026 update ([ecs.events](https://ecs.events/a/microsoft-foundry-adds-managed-agent-harness-preview)) _(secondary, unverified)_.

**What it has that Kerby lacks.** M365 and Teams publishing with Entra Agent ID, voice, browser automation, Insights and Agent Optimizer, BYO Cosmos DB, AKS deployment (coming).

**Where Kerby differs.** Azure-independent, BYOK across providers, a prompt registry with labels, exactly-once tool semantics, a simpler HTTP+SSE surface.

---

### Cloudflare: Agents SDK on Durable Objects

**What and status.** An open-source TypeScript framework, not a hosted service. "The Agents SDK runtime is a Durable Object with the Lifecycle installed, a Worker that routes requests to it, and the capabilities you attach to it" ([runtime](https://developers.cloudflare.com/agents/runtime/index.md)). Shipping actively; Nov 2026 changelog entries ([changelog RSS](https://developers.cloudflare.com/changelog/rss/agents.xml)):
- Pi 1.6 harness support (2026-11-20).
- Codex, Exo and Nanocode harnesses (2026-11-09).

**Details.**
- Capabilities: State, WebSockets, Scheduler (delay, date, cron, interval), MCPClientManager (OAuth, reconnection after restarts), Streams (durable token chunk log; "SSE resume works without client code").
- **Sessions** (experimental): history in the Durable Object's SQLite, with tree branching, compaction, **full-text search** and a change feed.
- Source for the above: [docs index](https://developers.cloudflare.com/agents/llms.txt), [Sessions](https://developers.cloudflare.com/agents/runtime/capabilities/sessions/index.md).
- Pluggable harnesses: Pi Durable ("durable… even if it is interrupted mid-turn"; handles crash recovery), Think, OpenCode, Codex, Claude Code ([Pi](https://developers.cloudflare.com/agents/harnesses/pi/index.md)).
- Models via `createAI`: Workers AI, AI Gateway catalog, vendor models ([models](https://developers.cloudflare.com/agents/models/index.md)).
- Routing supports jurisdiction and location hints ([routing options](https://developers.cloudflare.com/agents/runtime/routing/options/index.md)).

**Overlap with Kerby.**

| Axis                 | Overlap                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------- |
| Hosted runtime       | **Partial**: you write and deploy code on Workers; Cloudflare hosts it                  |
| Durable/resumable    | **Yes** (Durable Object per agent, durable job queue, Pi Durable mid-turn recovery)     |
| Stored conversations | **Yes**, per agent in SQLite                                                            |
| Querying history     | **Partial**: full-text search inside one Durable Object; no cross-agent listing service |
| Prompt management    | **No**                                                                                  |
| Tools/MCP            | **Yes**                                                                                 |
| BYOK/model choice    | **Yes** (any provider via AI SDK / AI Gateway)                                          |
| Isolation/residency  | **Partial**: per-agent Durable Object isolation, jurisdiction hints                     |
| Console              | **No**                                                                                  |

**Pricing.** Durable Objects on the Paid plan ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/index.md)):
- Requests: 1M/month included, then $0.15 per million.
- Duration: 400k GB-s included, then $12.50 per million GB-s.
- SQLite: rows read 25B included, then $0.001 per million; rows written 50M included, then $1.00 per million; storage 5 GB-month included, then $0.20/GB-month.

**What it has that Kerby lacks.** Edge per-agent actors, WebSocket state sync, scheduling, harness plurality, a cheap cost floor.

**Where Kerby differs.**
- Kerby is a finished multi-tenant service (console, API keys, sealed BYOK, prompt registry, transcript browsing, export and deletion); Cloudflare is a toolkit a tenant must assemble.
- Cloudflare is the "build it yourself" alternative a TypeScript-savvy tenant would weigh against Kerby.
- Similar philosophy: harness-agnostic runtime, durable execution.

---

### Other big-vendor offerings found (2025–2026)

**Mistral.**
- Studio "Prompts & Skills" (2026-07-09): immutable versions, owners, rollback, audit logs, and promotion via labels that triggers CI/CD ([Mistral news](https://mistral.ai/news/manage-prompts-and-skills-in-studio/)).
- The Agents and Conversations APIs (`client.beta.agents`, `client.beta.conversations`, which stored conversation history server-side) are replaced by the Mistral Agents SDK plus Studio deployments, either self-hosted or Mistral-managed ([docs](https://docs.mistral.ai/studio/agents/getting-started/from-agents-api)).
- Overlap with Kerby is high on prompt management with labels. Mistral is the one model vendor _expanding_ prompt management while OpenAI and Anthropic exit.

**Bedrock Managed Agents (OpenAI × AWS)**: covered under AWS. A notable precedent of one vendor's harness redistributed inside a hyperscaler.

**OpenAI Workspace Agents API**: triggers published ChatGPT workspace agents from backends ([docs index](https://developers.openai.com/llms.txt)). Aimed at ChatGPT Enterprise, not developer tenants. Little overlap.

**Decisions APIs**: OpenAI (GA Oct 2026) and Google Gemini Decision 1. These are "typed probabilistic judgment" endpoints and the closest analogue to Kerby's decision models. Kerby should position its decision models as provider-neutral and wired into runtime guardrails, versus standalone classifier endpoints.

## Appendix B: Framework platforms and durable execution

_Report title: Framework vendors with hosted runtimes and durable-execution vendors: how they compare to Kerby_

Research date: 2026-11-23. Unless a page says otherwise, every first-party page below was read on that date. "Secondary" marks claims that come only from press or third-party sources.

Axis key used in each section: **Runtime** = hosted agent runtime (the vendor runs the loop) · **Durable** = durable/resumable execution · **Threads** = stored conversations/threads API · **History query** = list/filter/full-text/semantic/analytics over chat history · **Prompts** = prompt management · **Tools/MCP** · **BYOK** = bring your own model key / model choice · **Isolation** = tenant isolation, data residency, self-host · **Console** = UI for non-engineers.

### Segment summary

- **Main pattern: these vendors host your code, while Kerby hosts only configuration.** LangSmith Agent Server, Mastra Platform, CrewAI AMP, Trigger.dev, Inngest, Vercel Workflows, Temporal Cloud and Restate Cloud all ask the customer to write the agent loop or graph in their SDK and deploy it, or to run workers. Kerby takes no tenant code: it runs prompts, MCP URLs and BYOK keys over HTTP. Two kinds of player share that config-only shape: Cadenya fully, and Letta Cloud, LangChain Managed Deep Agents and CrewAI Studio in part.
- **Closest match: Cadenya** (https://cadenya.com). It describes itself as a "hosted runtime for AI agents that use your API". Overlap with Kerby:
  - BYOK only ("Cadenya does not provide inference").
  - MCP, OpenAPI or HTTP tool sets, with trusted endpoints (an egress allow-list).
  - Durable, resumable "Objectives" with SSE and event history.
  - Agent "variations" holding model, prompts and tools, published and A/B-tested.
  - Tenant and subject tags with per-tenant erase.
  - "Auto mode": typed decision criteria on tool calls, powered by Typesafe.ai. This is close to Kerby's decision models.
  - Embeddable chat widget and a published price list ($0 / $49 per month).
  - Differences: Cadenya keeps execution logs for only 14 days, isolates by workspace rather than a database per tenant, and has no prompt labels like `production`.
- **Second closest: Letta Cloud.** It offers a hosted stateful-agents API: agents, conversations, list messages, and organisation-wide hybrid full-text and vector **message search**, which is the history-search feature Kerby has not built. Letta has since repositioned around Letta Code (a coding and personal-agent harness, MemFS, sandboxes). Its pricing page is now consumer- and team-oriented, and the developer API plan no longer appears first-party.
- **LangChain (LangSmith Agent Server, formerly LangGraph Platform / LangSmith Deployment)** is the most complete incumbent.
  - Assistants, threads, runs, crons and store, all on Postgres with checkpoint-based durability.
  - Prompt & Context Hub with commits, tags and environments, plus a Playground.
  - Cloud, hybrid, self-hosted or standalone deployment.
  - **Managed Deep Agents** (public beta) moves it towards Kerby's shape: you supply instructions, tools, MCP and model, and LangSmith runs the harness. It still needs a Python project, and it is Python-only.
- **Prompt management inside runtimes is spreading**:
  - LangSmith Prompt Hub.
  - Mastra Studio Editor: draft/published versions, prompt blocks, select a version per request.
  - Trigger.dev AI Prompts: `{{var}}` templates, versioned on deploy, dashboard overrides.
  - Agno: component versioning with draft, publish and rollback.
  - Cadenya: variations.
  - Only LangSmith has label/environment promotion equivalent to Kerby's movable labels.
- **Searching chat history is weak everywhere**:
  - Letta: FTS, vector and hybrid via RRF, cloud-only.
  - Convex Agent: hybrid text and vector over messages, but for LLM context.
  - Mastra: semantic recall into the agent's context, not an operator query API.
  - LangGraph: threads search filters on metadata and status only.
  - Agno: sessions list plus a traces filter DSL.
  - So a history query and analytics API would be a differentiator, not table stakes.
- **Durable-execution vendors (Temporal, Inngest, Restate, DBOS, Trigger.dev, Vercel Workflows) now market "durable agents"** but sell primitives: steps, activities, journals. They have no prompt store, no BYOK vault, no hosted conversation API and no end-user console. They are substitutes for Kerby's internal Absurd layer, and build-it-yourself alternatives for Kerby's customers. Exceptions edging up the stack:
  - Trigger.dev: `chat.agent` and Prompts.
  - Vercel: eve 1.0, GA on 2026-11-17, with multi-tenant memory, credentials and approvals.
  - Inngest: Agent Evals.
- **Tenant isolation**: no vendor in this segment advertises a separate database per end customer of the developer (Kerby's per-tenant Postgres). Isolation is offered as self-host, BYOC or hybrid (LangSmith Enterprise, Restate BYOC, Agno open source, Letta self-host, Convex self-host) or as region choice (Mastra us/eu, Vercel multi-region). Per-end-user scoping is a logical filter: `resourceId`, `user_id`, tenant/subject.
- **Same hosting stack as Kerby**: Mastra Platform runs on Railway (its region docs name Railway compute regions). Agno's tutorial deploys to Railway or Render.

---

### LangChain: LangSmith Agent Server (formerly LangGraph Platform, then LangSmith Deployment) and Prompt & Context Hub

**What it is.** A runtime for deployed LangGraph graphs, or for other frameworks wrapped as graphs: Google ADK, Claude Agent SDK, CrewAI, Strands, AutoGen. It also includes LangSmith observability, evals, Prompt Hub, Fleet (no-code agents), Engine, Sandboxes and LLM Gateway. Docs: "LangSmith Deployment is now **LangSmith Agent Server**" (https://docs.langchain.com/langsmith/deploy-overview.md). Agent Server is GA. **Managed Deep Agents** is in public beta on LangSmith Cloud and BYOC (https://docs.langchain.com/langsmith/python/managed-deep-agents-overview.md).

**Overlap with Kerby**
- **Runtime: yes.** API servers plus queue workers. Runs are leased, with at most one run per thread at a time, and streamed over SSE (https://docs.langchain.com/langsmith/agent-server.md). You deploy code from GitHub or the CLI. Managed Deep Agents runs the harness for you: you upload `agent.py`, `instructions.md`, skills, tools and MCP (same MDA URL).
- **Durable: yes.** Postgres checkpoints are written after each step, so an interrupted run resumes from the last checkpoint. Durability modes are `async` and `exit`. Redis is used only for pub/sub (agent-server.md). It is checkpoint-per-node: no documented exactly-once guarantee for tool calls.
- **Threads: yes.** Assistants, threads, runs, crons and store. Threads can be copied, pre-populated with "supersteps", and have their state history read (https://docs.langchain.com/langsmith/use-threads.md). Covers webhooks, human-in-the-loop, "double-texting" (concurrent input on a thread), and MCP/A2A exposure.
- **History query: partial.** `threads.search` filters by status (`idle`/`busy`/`interrupted`/`error`) and metadata (use-threads.md). The store has optional semantic search (agent-server.md). LangSmith tracing gives thread-level filtering and evals. No full-text search over messages in the Agent Server API.
- **Prompts: yes.** Prompt & Context Hub covers tags, commits, commit webhooks, versioned "contexts" promoted through environments, and a Playground ("Prompt Hub and Playground" is on every plan) (https://docs.langchain.com/langsmith/prompt-context-hub.md, https://www.langchain.com/pricing).
- **Tools/MCP: yes.** Fleet accepts "Add tools with a remote MCP server". MDA supports `define_mcp` remote servers. Deployments can be exposed as MCP servers (pricing page; MDA page).
- **BYOK: yes,** because model calls happen in your code. There is also an optional pay-as-you-go LLM Gateway (pricing page).
- **Isolation: yes, via self-host.** Cloud runs on AWS, Azure or GCP; options are Hybrid (your data plane), self-hosted control plane (Enterprise), and standalone server (your own Postgres, Redis and license). The control plane creates a Postgres database **per Agent Server deployment**, not per end customer (deploy-overview.md; agent-server.md).
- **Console: yes.** LangSmith UI, Studio, and Fleet for "everyday language" agent creation (pricing page).

**Pricing** (https://www.langchain.com/pricing):
- Plans:
  - Developer: $0 for 1 seat, with 5k base traces per month.
  - Plus: $39 per seat per month, with 10k traces and 1 Small serverless Agent Server free.
  - Enterprise: custom (self-hosted or hybrid).
- Usage is billed in LSU at $1.00 per LSU:
  - Runtime: 0.0675 LSU per vCPU-hour and 0.0090 LSU per GiB-hour.
  - Database: 0.177 LSU per vCPU-hour and 0.025 LSU per GiB-hour.
  - Sandboxes: 0.0576 LSU per vCPU-hour.
- LSU billing has applied to production deployments since 2026-10-01 (LangChain KB: https://kb.langchain.com/articles/2780309193). Trace overage of $2.50 per 1k base traces is secondary (dailyaifixs.com).

**Does what Kerby doesn't:** graph or code-level control; crons; long-term store with semantic search; human-in-the-loop interrupts; evals, Engine and auto-diagnosis; sandboxes; self-host and BYOC; A2A; prompt environments and commit webhooks; Slack channels (MDA).

**Where Kerby differs:**
- No tenant code and no Python project.
- Kerby is TypeScript/HTTP-first; MDA is Python.
- Database per _end tenant_, versus a database per deployment.
- Exactly-once tool calls as a stated guarantee.
- Transcripts browsable by `externalUserId` in a console.

### Letta (formerly MemGPT): Letta Cloud, Agent SDK and App Server

**What it is.** A stateful-agent platform: agents have persistent memory (memory blocks, git-versioned "MemFS"), and each agent has multiple conversations. In 2026 the product centre moved to **Letta Code**, an open-source harness, CLI, web and desktop app, with Letta Agent SDK and App Server for embedding. Cloud agents run tools in managed sandboxes or on your own machine (https://docs.letta.com/llms.txt). Status: GA. The legacy REST API reference is still published (https://docs.letta.com/api/resources/agents).

**Overlap with Kerby**
- **Runtime: yes.** `backend: "cloud"` hosts agent state in Letta Cloud and runs tools in a managed sandbox. Other options: BYO machine, local, or a self-hosted App Server (https://docs.letta.com/agent-sdk/deployment/index.md).
- **Durable: partial.**
  - Memory and history persist across connections. Messages sent during a turn are queued by the runtime.
  - The docs state that the SDK does **not** replay events missed while disconnected; you reconcile with `listMessages()` or `bootstrapState()`.
  - The docs advise against blind retries after `send()`.
  - Source: https://docs.letta.com/agent-sdk/sessions/index.md. No crash-resume or exactly-once tool-call guarantee is documented.
- **Threads: yes.** Agent → conversations (`conv-xxx`) via `client.conversations` (`create`, `list`, `retrieve`, `update`, `listMessages`). Turns emit reasoning, tool calls and results with `runId` (sessions page).
- **History query: yes, ahead of Kerby.** `POST /v1/messages/search` searches across the organisation with agent, conversation and date filters, in `fts`, `vector` or `hybrid` (RRF) mode. It is "a cloud-only feature" (https://docs.letta.com/api/resources/messages/methods/search). Agents also get a `conversation_search` tool.
- **Prompts: no** versioned prompt registry. Agents rewrite their own system prompts ("system prompt learning") (llms.txt).
- **Tools/MCP: yes.** The SDK connects stdio, HTTP and SSE MCP servers; remote MCP tools carry no Letta credit cost. There are also client-side tools and a hosted Letta MCP server (https://docs.letta.com/pricing/index.md, llms.txt).
- **BYOK: yes,** on all plans, plus Letta credits for hosted models. Many providers are supported, including coding plans and local models (pricing page; llms.txt).
- **Isolation: partial.** Fully local runtime or self-hosted App Server, "no Letta account required". Enterprise adds RBAC and SAML/OIDC. No per-customer database or data-residency statement found.
- **Console: yes.** chat.letta.com web and desktop app, team sharing and permissions.

**Pricing** (https://docs.letta.com/pricing/index.md):
- Free: $0, 3 agents, BYOK.
- Pro: $20 per month including $20 of credits, 20 agents.
- Teams Pro: $20 per seat per month.
- Enterprise: custom.
- Server-side tool CPU costs $0.00015 per second.
- A developer "API plan" ($20 per month + $0.10 per active agent) appears only in secondary sources (https://rywalker.com/research/letta, checked 2026-09-15). It is **not** on the current first-party pricing page, so treat it as unverified.

**Does what Kerby doesn't:** long-term self-editing memory; sleep-time "dreaming"; hybrid message search; sandboxes and computers; schedules; messaging channels; self-host.

**Where Kerby differs:** Kerby has a durable, exactly-once turn engine, prompt versioning with labels, decision-model guardrails, and database-per-tenant isolation. Letta is moving towards coding and personal agents, not multi-tenant B2B runtimes.

### Mastra: Mastra Platform (formerly Mastra Cloud)

**What it is.** A TypeScript agent framework (Apache-2.0) plus a hosted platform with three products: Observability, Studio (hosted) and Server (production API). The platform adds hosted databases (Turso, Neon, Postgres), environments, us/eu regions **on Railway**, Connect (managed OAuth accounts), and a Gateway (https://mastra.ai/docs/mastra-platform/overview.md, https://mastra.ai/docs/mastra-platform/deploy/regions.md). Status: GA; durable agents in beta.

**Overlap with Kerby**
- **Runtime: yes,** for your Mastra code via `mastra deploy` (platform overview).
- **Durable: partial (beta).** `createDurableAgent()` runs the loop inside a workflow. Events go through pub/sub, so clients can reconnect without missing chunks, and run state survives restarts. Optional Inngest-backed step memoisation (https://mastra.ai/docs/harness/durable-agents.md, "Beta: breaking changes may occur"). Workflows support snapshots and suspend/resume (https://mastra.ai/llms.txt).
- **Threads: yes.** Threads plus `resourceId` (the owning user or org) via storage adapters (https://mastra.ai/docs/memory/message-history.md).
- **History query: partial.** Semantic recall runs vector search over past messages, including other threads of the same user, but it feeds agent context (https://mastra.ai/docs/memory/semantic-recall.md). Platform observability offers "searchable traces". Trace Intelligence (private beta) clusters goals and sentiment (platform overview).
- **Prompts: yes.** The Studio **Editor** works "like a CMS": draft vs published versions, restore old versions, shared "prompt blocks" with template syntax, and selection by `status` or `versionId` per request for A/B (https://mastra.ai/docs/studio/editor.md). There is no named-label model beyond published/draft; environments exist at platform level.
- **Tools/MCP: yes,** as MCP client and server (llms.txt).
- **BYOK: yes,** because model calls run in your code. Gateway is optional.
- **Isolation: partial.** Self-host anywhere. Platform region choice is us/eu. A database per project or environment; per-tenant isolation is left to the developer (hosted-databases doc suggests Turso "for per-tenant isolation").
- **Console: yes.** Studio and Editor for non-engineers; Agent Builder for browser-only agents.

**Pricing** (https://mastra.ai/pricing), per workspace per month:
- Free: $0.
- Starter: $25.
- Team: $250 (SOC 2).
- Enterprise: custom.
- Overage: compute $0.25 per vCPU-hour and $0.25 per GB-hour; observability $10 per 100k events.
- Dedicated project sizes: Small $25, Medium $100, Large $200.

**Does what Kerby doesn't:** workflows engine; semantic recall, working memory and observational memory; evals; sandboxes and workspaces; Slack/Discord/Telegram channels; open-source self-host.

**Where Kerby differs:** no code deploy; BYOK vault plus egress guard; exactly-once tool calls as a core property rather than a beta add-on; per-tenant databases; immutable numbered versions plus movable labels.

### CrewAI: CrewAI AMP (Agent Management Platform; formerly CrewAI Enterprise)

**What it is.** A hosted build and run platform for CrewAI Crews and Flows. Studio is a visual editor with an AI copilot. Deployments come from GitHub; each deployed crew gets its own URL with `/inputs`, `POST /kickoff` and `GET /status/{kickoff_id}` (https://docs.crewai.com/edge/en/api-reference/introduction.md). Status: GA, aimed at enterprises ("Used by 65% of the Fortune 500", https://www.crewai.com/pricing). The rename from "Enterprise" to AMP is confirmed only by secondary sources (javisreview.com); first-party docs use "CrewAI AMP".

**Overlap with Kerby**
- **Runtime: yes.** Hosted crews/flows with automatic scaling and cron (pricing page).
- **Durable: partial.** Framework checkpointing: JSON or SQLite providers, restore from a checkpoint, fork (https://docs.crewai.com/edge/en/concepts/checkpointing.md). Nothing found on hosted crash-resume.
- **Threads: partial.** "Conversational Flows" keep session state and history keyed by `session_id`, which is the AG-UI `threadId` (https://docs.crewai.com/edge/en/guides/frontend/conversational-flows.md). The AMP REST API is kickoff/status-oriented, with no thread listing found.
- **History query: no** API found; tracing in AMP (https://docs.crewai.com/edge/en/observability/tracing.md).
- **Prompts: no** versioned prompt registry found; agents are defined in code or Studio.
- **Tools/MCP: yes.** MCP integration; "Export as MCP server" (pricing page).
- **BYOK: yes.** "LLM management" (pricing page). The underlying model access is your own.
- **Isolation: yes (Enterprise).** CrewAI cloud, your VPC, or your own infrastructure; FedRAMP High option per secondary sources (aiagentsquare.com).
- **Console: yes.** Studio, workflow chat UI, Slack and Teams, usage dashboard.

**Pricing** (https://www.crewai.com/pricing):
- Basic: free, with "50 workflow executions/month".
- Enterprise: custom, with SSO, RBAC, PII redaction, a 45-day onboarding and forward-deployed engineering.
- No self-serve paid tier.

**Does what Kerby doesn't:** multi-agent crews; visual builder; enterprise connectors; guardrails and training; on-premises deployment.

**Where Kerby differs:** a conversation-first API with stored transcripts; self-serve developer product; BYOK keys sealed in Kerby; prompt versions and labels.

### Agno: AgentOS (self-hosted runtime) and AgentOS Control Plane

**What it is.** A Python SDK plus the AgentOS runtime (open source), which you run in your own cloud. A hosted **control plane** UI connects "directly from your browser to the runtime endpoint" (https://docs.agno.com/agent-os/connect-your-os.md), so runtime data stays in your infrastructure. Status: GA.

**Overlap with Kerby**
- **Runtime: no (self-hosted).** You run AgentOS yourself; Agno does not host the loop. It does offer "Claude and Codex as Services" behind AgentOS (https://docs.agno.com/llms.txt).
- **Durable: partial.** Background runs plus "durable execution with a supported queue store and a retry policy". The API can resume disconnected streams (https://docs.agno.com/tutorials/agents-as-api.md, https://docs.agno.com/features/api.md).
- **Threads: yes.** Sessions: create, list, rename, delete, "pull every run in a session", per-user isolation via `user_id` (features/api.md).
- **History query: partial.** Traces: "search with a filter DSL", grouped by session. Memory search by topic. Metrics: daily runs, sessions, users and tokens (features/api.md).
- **Prompts: partial.** "Components: version your agents, teams and workflows. Manage drafts, publish, roll back" (features/api.md). No standalone prompt registry with labels found.
- **Tools/MCP: yes.** MCP client; AgentOS also serves as an MCP server.
- **BYOK: yes,** because the runtime is yours.
- **Isolation: yes.** Self-host; data stays in your cloud. Enterprise adds "end-user identity, roles and audit logs" (pricing).
- **Console: yes.** Control plane with chat, sessions, traces, studio, memory, knowledge, evals, approvals and scheduler.

**Pricing** (https://www.agno.com/pricing):
- Runtime: free (open source).
- Pro: $150 per month for 1 live AgentOS connection and 3 seats. Add-ons: seats $30, connections $95, SAML $300.
- Enterprise: custom.

**Does what Kerby doesn't:** you keep the data; knowledge/RAG; evals; scheduler; approvals; Slack/WhatsApp interfaces; metrics.

**Where Kerby differs:** Kerby is hosted and multi-tenant with no ops for the customer. Agno is the "run it yourself" alternative, so a direct competitor for teams that refuse to send data to a third party.

### Vercel: AI SDK, Workflows / Workflow SDK, WorkflowAgent, eve

**What it is.**
- **AI SDK:** free, open-source TypeScript library.
- **`WorkflowAgent`** (`@ai-sdk/workflow`): "durable, resumable agents" that run inside a workflow, with tool approvals that survive step boundaries (https://ai-sdk.dev/llms.txt).
- **Vercel Workflows:** managed durable execution, GA on 2026-04-16 (https://vercel.com/blog/a-new-programming-model-for-durable-execution).
- **Workflow SDK:** open source, with pluggable "Worlds": Local, Vercel, Postgres (https://useworkflow.dev/llms.txt).
- **eve 1.0:** open-source production agent framework built on these, GA on 2026-11-17 (https://vercel.com/blog/eve-is-now-generally-available).

**Overlap with Kerby**
- **Runtime: partial.** Vercel hosts your eve or AI SDK code as functions plus Workflows plus Sandbox. It is not a configuration-only API.
- **Durable: yes.** An event-sourced log means every state transition is persisted. Steps are retried; hooks pause and resume; resumable streams; no maximum run duration (https://vercel.com/docs/workflows/pricing.md). eve "can pick up from its last completed step after a crash" (eve post).
- **Threads: partial.** eve has multiplayer sessions and session data in client libraries. The AI SDK leaves chat persistence to the app.
- **History query: no** first-party search API found.
- **Prompts: no** registry found. eve "dynamic definitions" load instructions, tools and models per session (eve post).
- **Tools/MCP: yes.** AI SDK MCP client; eve integrations directory.
- **BYOK: yes.** Any provider, or AI Gateway.
- **Isolation: partial.** Multi-region: "the region that creates each run also hosts its workflow data". Postgres World enables self-host. eve has multi-tenant memory, credentials and approval policies, but isolation is logical, in your app (eve post; useworkflow.dev).
- **Console: partial.** Workflow observability for developers; eve channels (Slack, Teams, Web Chat).

**Pricing** (https://vercel.com/docs/workflows/pricing.md, updated 2026-09-16):
- Workflow events: 50k included on Hobby, then $0.02 per 1k.
- Data written: 1 GB included, then $0.50 per GB.
- Retention: $0.50 per GB-month.
- Function compute billed separately.
- Limits: 25k events per run, 10k steps per run.

**Does what Kerby doesn't:** general durable workflows; sandboxes; channels; framework integrations; gateway; massive distribution.

**Where Kerby differs:** hosted conversation store plus prompt versioning plus BYOK vault as an API; no code. eve on Vercel is the most likely "build it yourself in a weekend" alternative for TypeScript teams.

### Convex: Agent component (`@convex-dev/agent`)

**What it is.** An agent component for the Convex reactive backend-as-a-service. It persists threads and messages, and live-updates clients (https://docs.convex.dev/agents). Status: GA component. Convex itself can be self-hosted (https://docs.convex.dev/self-hosting.md).

**Overlap with Kerby**
- **Runtime: partial.** Your agent code runs in Convex actions on Convex's cloud.
- **Durable: partial.** Workflows "can span agents, users, durably and reliably" via the Workflow component (agents overview).
- **Threads: yes.** Threads, messages and streaming; threads are shareable by multiple users and agents (agents overview).
- **History query: yes.** "Built-in hybrid vector/text search for messages", used for LLM context. Developers can also query the tables directly (agents overview; https://docs.convex.dev/search/overview.md).
- **Prompts: partial.** The agent playground lets you "iterate on prompts and context settings". No versioning found.
- **Tools/MCP: yes** (tools). MCP support for agents is not verified.
- **BYOK: yes,** via the AI SDK or Convex AI Gateway.
- **Isolation: partial.** Data region selectable on all plans; self-host option (https://www.convex.dev/pricing).
- **Console: partial.** Developer dashboard and agent playground.

**Pricing** (https://www.convex.dev/pricing):
- Free & Starter: $0 plus pay as you go.
- Professional: $25 per developer per month.
- Business: $2,500 monthly minimum.

**Does what Kerby doesn't:** reactive UI sync; hybrid search over messages; usage tracking and rate limiting per user; RAG component.

**Where Kerby differs:** Convex is a backend you build on (you write and deploy code); Kerby is a finished runtime API.

### Temporal: Temporal Cloud and AI integrations

**What it is.** The durable-execution leader. MIT open source plus Temporal Cloud. Raised a $300M Series D at a $5B valuation in Feb 2026 (https://temporal.io/llm-info).
- The **OpenAI Agents SDK integration is GA**: "As of March 23rd, 2026 … Generally Available" (https://temporal.io/blog/announcing-openai-agents-sdk-integration). It now includes sandbox support.
- There is also a Google ADK integration.
- **Workflow Streams** (durable token streaming) is in public preview, announced at Replay 2026 in May (llm-info).

**Overlap with Kerby**
- **Runtime: no.** You run workers; Temporal Cloud runs the orchestration service.
- **Durable: yes.** The reference implementation: model and tool calls run as Activities, with exactly-once semantics at the workflow level (llm-info).
- **Threads: no** (no conversation API).
- **History query: no** for chat. Workflow visibility queries only.
- **Prompts: no.**
- **Tools/MCP: no** (tools are your code).
- **BYOK: n/a,** your code.
- **Isolation: yes.** Self-host the open source; Cloud namespaces; multi-region replicas.
- **Console: no** (developer UI only).

**Pricing** (https://temporal.io/pricing):
- Pay-as-you-go from $0 per month, with $150 of credits over 90 days.
- Actions: $50 per million for the first 5M, falling to $25 per million.
- Storage: active $0.042 per GBh, retained $0.00105 per GBh.
- Business plan: from $500 per month or 10% of usage.
- Startup program: $6,000 of credits.

**Relevance:** a substitute for Absurd, and the base on which competitors build. Cadenya publishes "Temporal AI Agents: building the agentic loop as a workflow" (https://cadenya.com/handwritten/agentic-loop-in-temporal.md).

### Inngest: Durable Agents, AgentKit, Agent Evals, Sandboxes

**What it is.** A durable-functions platform, open source and self-hostable. The docs now centre on **"Durable Agents"**: each model call and tool call is a `step.run()` checkpoint, so a resumed run does not re-run or re-pay completed calls. Waits for humans hold no worker. Each run records the agent's trajectory (https://www.inngest.com/docs-markdown/durable-execution/durable-agents). AgentKit still has its own docs site (https://agentkit.inngest.com/llms.txt) but is not referenced in the main docs index (0 mentions in https://www.inngest.com/llms.txt). Its current status is unverified.

**Overlap with Kerby**
- **Runtime: no.** The loop runs in your app; Inngest coordinates.
- **Durable: yes.** Step checkpoints; failed steps retry; completed steps return saved results. This is the same "each tool call runs once" property Kerby has.
- **Threads: no** (Agent Evals has "Sessions" for scoring).
- **History query: partial.** Run traces; evals and experiments on real traffic.
- **Prompts: partial.** "Compare models and prompts" via experiments; no registry.
- **Tools/MCP: no** built-in (your code).
- **BYOK: yes** ("any model provider").
- **Isolation: yes** (self-host).
- **Console: no** (developer dashboard).

**Pricing** (https://www.inngest.com/pricing):
- Free: $0 with 50k executions.
- Pro: $99 per month with 1M executions, then $50 per million.
- Business: $499 per month with 10M executions, then $25 per million.
- Enterprise: custom.
- Sandboxes: $0.0396 per vCPU-hour and $0.0108 per GB-hour.

### Restate: Restate Cloud, BYOC and AI agents

**What it is.** A durable-execution runtime (journaled RPC, virtual objects) with explicit agent patterns: durable agents, **durable sessions** ("persistent, isolated agent sessions keyed by ID … with built-in concurrency control"), human-in-the-loop, multi-agent, and integrations with agent SDKs (https://docs.restate.dev/llms.txt). Announced a $20M Series A (banner on https://www.restate.dev/pricing; the date is not stated there).

**Overlap with Kerby**
- **Runtime: no.** You host the services; Restate Cloud hosts the server.
- **Durable: yes.** Every LLM call, tool execution and routing decision is persisted.
- **Threads: partial.** Durable sessions keyed by ID, with state in virtual objects. No hosted conversation store or list API.
- **History query: no** (journal inspection and traces only).
- **Prompts: no.**
- **Tools/MCP: no** built-in.
- **BYOK: n/a.**
- **Isolation: yes.** Self-host and BYOC.
- **Console: no** (developer UI).

**Pricing** (https://www.restate.dev/pricing):
- Free plan: "100k durable actions per month".
- One action per 64 KiB of payload.
- Paid tier prices are rendered client-side and were not readable: unverified.

### DBOS: Transact (open-source library), Conductor and DBOS Cloud

**What it is.** A Postgres-backed durable-workflow library (Python, TypeScript, Go). Conductor is the control plane for "agents & workflows": recovery, alerting, audit logs, RBAC, autoscaling. DBOS Cloud supports bring-your-own Postgres (https://docs.dbos.dev/llms.txt). AI guides cover the quickstart, human-in-the-loop, streaming and parallel agents.

**Overlap with Kerby**
- **Runtime: no** (library in your process).
- **Durable: yes** (Postgres checkpoints). Architecturally the closest analogue to Kerby's Absurd choice: Postgres-only durability.
- **Threads, History query, Prompts, Tools/MCP: no.**
- **BYOK: n/a.**
- **Isolation: yes** (self-host, BYO database).
- **Console: no** (Conductor workflow console for developers).

**Pricing** (https://www.dbos.dev/pricing):
- Transact: open source.
- Pro: $99 per month (2 seats, 3 apps, 1M checkpoints, then $50 per million).
- Teams: $499 per month (10 seats, 10M checkpoints, then $40 per million).

### Trigger.dev: `chat.agent`, Sessions, AI Prompts

**What it is.** An open-source (Apache 2.0) TypeScript platform for durable tasks, cloud or self-hosted. Checkpoint-resume snapshots mean "paused agents … aren't billed while waiting". It has no maximum run duration (https://trigger.dev/llms.txt).
- **`chat.agent`** runs each conversation as one long-lived task. It survives refreshes, deploys and crashes, and resumes mid-stream. `useChat` connects through a transport (https://trigger.dev/docs/ai-chat/overview.md).
- **AI Prompts:** `{{variable}}` templates defined in code, versioned on each deploy, with dashboard **overrides** without redeploying, per-version generation tracking, and token, cost and latency per prompt (https://trigger.dev/docs/ai/prompts.md).

**Overlap with Kerby**
- **Runtime: partial.** Hosted compute, but you write the loop with the AI SDK.
- **Durable: yes.**
- **Threads: partial.** Durable sessions per chat; the message store is your responsibility, not a query API.
- **History query: partial.** TRQL, a ClickHouse-backed query language over runs and LLM spans; dashboards.
- **Prompts: yes,** and close to Kerby: versions, variables, overrides, metrics. No named labels; overrides play that role.
- **Tools/MCP: partial** (your code; an MCP server for coding agents).
- **BYOK: yes** (your code).
- **Isolation: yes** (self-host; per-customer concurrency for multi-tenant SaaS).
- **Console: partial** (developer dashboard; prompt overrides usable by non-engineers).

**Pricing** (https://trigger.dev/pricing):
- Free: $0 with $5 of credits and 20 concurrent runs.
- Hobby: $10 per month ($10 of credits, 50 concurrent runs).
- Pro: $50 per month ($50 of credits, 200+ concurrent runs).
- Enterprise: custom.
- Compute from $0.0000169 per second (Micro).
- HIPAA BAA add-on: $500 per month.

### Cadenya: hosted agent runtime startup (closest match to Kerby)

**What it is.** "Hosted runtime for AI agents that use your API" (https://cadenya.com). Pieces:
- Agents with variations: model, prompts, tools.
- **Objectives**: durable, resumable runs.
- Tool Sets built from OpenAPI, MCP or HTTP.
- Memory layers.
- Embeddable React **widgets**.
- Webhooks, CLI, YAML config-as-code.

Status: GA with self-serve signup. Recent changelog (2026-10-18): Auto mode, tenant memory, queued messages (https://cadenya.com/handwritten/changelog/2026-10-18.md).

**Overlap with Kerby**
- **Runtime: yes** (no customer code).
- **Durable: yes,** as claimed: "Durable, resumable agent runs" (https://cadenya.com/features/objectives.md). Mechanism undisclosed. Its blog describes the agent loop built on Temporal, but that this is Cadenya's own engine is [INFERENCE] only.
- **Threads: yes.** Objectives with `listEvents`, SSE `streamEvents`, tool-call retrieve and approve, queued messages. Widget conversations: list per tenant/subject, Last-Event-ID resumable SSE (https://cadenya.com/docs/llms.txt).
- **History query: partial.** List objectives; list tenants with a `query` type-ahead; feedback search by comment and sentiment; analytics by tenant/subject tags. No full-text search over messages found.
- **Prompts: partial.** Variations are versioned configurations, with a canary/default split and swappable models. There are agent publish/archive states. No `{{var}}` prompt registry with labels found.
- **Tools/MCP: yes.**
  - MCP, OpenAPI and HTTP tool sets, with secrets in envelope encryption and trusted endpoints.
  - Approval rules and "Auto mode" decision criteria via Typesafe.ai. This is a direct analogue of Kerby's decision-model guardrails.
  - "Progressive tool discovery" keeps tool schemas out of the context window.
- **BYOK: yes, required.** OpenAI, Anthropic, Gemini, OpenRouter, Bedrock, Vertex, or OpenAI-compatible; a $5 OpenRouter starter key (https://cadenya.com/docs/data-and-security.md, https://cadenya.com/docs).
- **Isolation: partial.**
  - Workspaces (Dev/Prod), tenant and subject tags, "Erase a tenant", AES-256 at rest.
  - **Execution logs are kept 14 days.** Data can be retrieved for 30 days after a subscription ends.
  - No self-host and no per-tenant database found (data-and-security).
- **Console: yes.** Dashboard, debugger, feedback, widget for end users.

**Pricing** (https://cadenya.com/pricing):
- Free: $0 with 1 widget, 3 variations, 1,000 loops per month.
- Growth: $49 per month with 5 widgets, 100 variations, 50k loops, then $0.0015 per loop (a loop is one LLM request).
- Enterprise: custom.
- SSO add-on: $50 per month.

**Where Kerby differs:**
- Kerby keeps every transcript permanently, versus 14-day execution logs.
- Kerby gives each tenant a separate Postgres database plus pg_dump export.
- Kerby has named prompts with immutable versions and labels, and `{{variables}}`.
- Kerby is harness-agnostic behind `AgentRuntime`.

**Where Cadenya leads:** widgets, memory layers, OpenAPI import, sub-agents and agent pools, schedules, webhooks, feedback-driven A/B of variations, config-as-code with plan/apply.

### Other startups seen (not covered in depth)

- **Agentuity:** "cloud platform built for AI agents". V1 GA announced 2026-02-03, with storage, sandboxes, evals and deploy-anywhere (secondary: https://www.eejournal.com/industry_news/agentuity-launches-v1-of-cloud-platform-built-for-ai-agents/). Its pricing page returned HTTP 503 and its llms.txt returned 410 on 2026-11-23, so current status is unverified. It deploys your agent code, so it is a code host rather than a config runtime.
- **Orkes Conductor / agentspan.ai:** agentspan.ai resolves to Orkes Conductor's "Agents & AI" docs (durable workflow engine with agent support; https://agentspan.ai). Not analysed further.
- **Dapr Agents / Cloudflare Agents (Durable Objects, "Project Think") / Microsoft Foundry Agent Service:** appear in 2026 "agent runtime" roundups (secondary: https://orca.security/resources/blog/best-ai-agent-runtime-tools-platforms/, https://thenewstack.io/agent-runtime-application-server/). The cloud and platform vendors are outside this segment.

## Appendix C: Prompt management and observability

_Report title: Segment: prompt management + LLM observability / LLMOps (as of 2026-11-23)_

Scope: platforms that overlap with Kerby's **prompt management** (named prompts, immutable versions, movable labels, `{{vars}}`, playground) and its **chat-history querying** (sessions/threads, list by end user, search, analytics). Kerby axes: hosted runtime · durable execution · conversations API · history query/search · prompt mgmt · tools/MCP · BYOK · isolation/self-host · console for non-engineers.

### Segment summary

- **Almost nobody here runs the agent loop for the tenant.** These products sit _beside_ the app: they serve prompts through an SDK (with a client-side cache) and ingest traces via OTel or SDK. The app still owns the loop, the model call, tool execution and the conversation store. Exceptions, partial: PromptLayer (server-side MCP tool loop plus managed Workflows), Portkey (prompt `completions` endpoint, a single call), Braintrust `invoke()` (a single prompt call; the caller handles tool calls), LangSmith **Agent Server** (a real hosted runtime with threads and persistence, but you deploy your own LangGraph code), and Agenta (pivoted 2026-07 into a hosted agent workspace).
- **The prompt-versioning model has converged on Kerby's design:** immutable versions 1..N plus movable pointers (labels, tags or environments), with `production` as the default. Langfuse (`production`/`latest`/custom labels, `{{var}}`), LangSmith (commits plus tags, reserved `staging`/`production` environments, f-string/mustache), PromptLayer (release labels plus % / segment A/B "dynamic labels", f-string/jinja2), Phoenix/AX (immutable versions plus tags), Weave (`:vN`, `:latest`, `:production` aliases), Braintrust (versions plus environments, mustache/nunjucks), Helicone (versions plus environments, `{{hc:name:type}}`), Agenta 1.0 (git-like variants plus environments). So Kerby's prompt model is table stakes here, not a differentiator. The difference is that in Kerby the version is resolved **inside the runtime** (`prompt: {name, label}` on the conversation), with no SDK fetch or cache-staleness window. Langfuse's default cache TTL is 60 s; LangSmith's is 300 s with SWR.
- **Querying chat history is where this segment is far ahead of Kerby.** Langfuse has session replay plus ClickHouse full-text search over input/output (UI and API `matches` operator). LangSmith has threads plus full-text filters plus **Insights** (LLM summarisation and hierarchical clustering of conversations, continuous, BYOK model keys). Braintrust has SQL filters plus full-text plus **Topics** (embedding clustering of summaries). Latitude V2 has **semantic plus exact search over 100% of traces**. Arize AX has **Signal** (scheduled clustering of failures into issues). Agent Lens (CoreWeave, the Weave successor) clusters broken conversations. PromptLayer has content search plus "User Intent/Agent Intent" fields. Kerby today has list, paging, by-`externalUserId` browsing and run traces, but no full-text, semantic or clustering features.
- **Consolidation and churn in 2025–2026 is heavy:** Humanloop was shut down (2025-09-08, Anthropic acqui-hire). Langfuse was acquired by ClickHouse (2026-01-16) and continues. Helicone was acquired by Mintlify (2026-03-03) and is in maintenance mode, with the site now saying "part of Experiential Labs". Portkey was acquired by Palo Alto Networks (closed 2026-05, secondary sources) and is now the Prisma AIRS AI Gateway. W&B became **CoreWeave Forge** (2026-09-30), with Weave succeeded by Agent Lens (preview). Vellum pivoted to a personal assistant (2026-06, secondary) and is shutting that down (2026-12-13). The status of its developer platform is unverified. Latitude **killed its prompt manager and gateway** (V1 sunset 2026-10-30) and went observability-only. Agenta pivoted from prompt management to a hosted agent workspace (2026-07-21). Pezzo is dormant.
- **Market signal for Kerby:** two vendors (Latitude, Agenta) abandoned "prompt manager + gateway on the critical path". Latitude explicitly sells "Latitude is no longer on the critical path". Agenta moved the other way, toward _running_ agents. Kerby's bet (runtime + prompts + history in one hosted service) sits where Agenta and LangSmith Agent Server are heading, not where the pure prompt CMSs were.
- **Closest to Kerby:**
  1. **PromptLayer**: prompt registry with release labels, a playground, workspace-managed **remote MCP servers whose tool loop PromptLayer executes**, encrypted workspace env vars for MCP auth headers, managed Workflows run server-side, request search, and self-host on Enterprise. It lacks a durable conversation/thread runtime API and per-tenant DB isolation (unverified).
  2. **LangSmith (Agent Server + prompts + threads + Insights)**: the most complete overlap, but code-first (you deploy LangGraph graphs), and seat plus LSU pricing.
  3. **Langfuse**: the best open-source prompt and session store (MIT, self-host). It is adding an AI Gateway (beta) that holds provider keys. It does not run agents.
  4. **Portkey**: prompt library plus `/prompts/{id}/completions` execution plus an MCP gateway plus a **`/v1/decisions` typed-judgment API with guardrails**, the only direct analogue to Kerby's "decision models" found in this segment.
- **Where Kerby is distinct here:** it runs the loop durably (exactly-once tool calls, crash-resume), it is the system of record for transcripts (paged reads, SSE replay) rather than a telemetry sink, it has a separate Postgres DB per tenant plus export/delete, and it is a BYOK-only "no tenant code" model. Gaps compared with this segment: search, clustering and insights over history, online evals and annotation, datasets and experiments, A/B traffic splitting on labels, OTel ingestion of external agents, and self-host.

#### Quick overlap matrix (Y = yes, P = partial, N = no)

| Player              | Runs loop                 | Durable                            | Conv. API                | History search                       | Prompt mgmt                | MCP                                | BYOK                  | Self-host / isolation               | Non-eng UI               |
| ------------------- | ------------------------- | ---------------------------------- | ------------------------ | ------------------------------------ | -------------------------- | ---------------------------------- | --------------------- | ----------------------------------- | ------------------------ |
| Langfuse            | N                         | N                                  | P (sessions, read)       | Y full-text                          | Y                          | P (Langfuse MCP server, data only) | P (gateway beta)      | Y MIT                               | Y                        |
| LangSmith           | P (Agent Server, Fleet)   | P (Agent Server persistence/queue) | Y (Agent Server threads) | Y full-text + Insights clustering    | Y                          | P                                  | Y                     | Enterprise add-on                   | Y                        |
| Braintrust          | P (`invoke` single call)  | N                                  | N                        | Y SQL/full-text + Topics             | Y                          | N (unverified)                     | Y                     | BYOC (Enterprise)                   | Y                        |
| PromptLayer         | P (MCP loop, Workflows)   | N (unverified)                     | N                        | Y content search                     | Y                          | Y managed MCP                      | Y (unverified detail) | Enterprise self-host                | Y                        |
| Portkey             | P (prompt completions)    | N                                  | N                        | P (log filters)                      | Y                          | Y MCP gateway                      | Y                     | Hybrid/self-host (Ent), OSS gateway | Y                        |
| Helicone            | N                         | N                                  | P (sessions query API)   | P (HQL SQL)                          | Y                          | N                                  | Y (gateway)           | Y OSS                               | Y                        |
| Arize Phoenix/AX    | N                         | N                                  | P (sessions)             | Y filter exprs; AX Signal clustering | Y                          | N                                  | P (AX BYOK for Alyx)  | Phoenix ELv2; AX Ent self-host      | Y                        |
| Weave / Agent Lens  | N                         | N                                  | P (threads)              | P; Agent Lens clustering             | P (code-published objects) | N                                  | n/a                   | Enterprise dedicated (unverified)   | P                        |
| Latitude V2         | N (removed)               | N                                  | P (sessions)             | **Y semantic + exact**               | **N (removed)**            | N                                  | n/a                   | Y MIT                               | Y                        |
| Agenta (2026)       | **Y**                     | unverified                         | Y (sessions)             | P                                    | P (legacy 1.0)             | Y                                  | Y                     | Y MIT                               | Y                        |
| Vellum dev platform | Y (Workflows, Agent Node) | unverified                         | unverified               | P                                    | Y                          | unverified                         | Y                     | Enterprise self-host                | Y. **Status unverified** |
| Humanloop           | dead                      |                                    |                          |                                      |                            |                                    |                       |                                     |                          |
| Pezzo               | N                         | N                                  | N                        | N                                    | Y (stale)                  | N                                  |                       | OSS (dormant)                       | P                        |

---

### Langfuse

- **What and status:** an open-source LLM engineering platform (tracing, prompt management, evals). **Acquired by ClickHouse on 2026-01-16.** It stays open source and self-hostable, and Cloud runs as before ([GitHub announcement, 2026-01-16](https://github.com/orgs/langfuse/discussions/11593); [langfuse.com/press](https://langfuse.com/press)). The pricing page now references ClickHouse support policy and ISO 27701 coverage ([pricing](https://langfuse.com/pricing)). GA.
- **Prompt versioning:** versions are immutable (`1,2,3…`, scoped to the whole prompt or skill object). Labels are movable pointers: `production` is the default, `latest` is auto-updated, and custom labels can be used for staging, tenants or A/B. Rollback means moving a label ([concepts](https://langfuse.com/docs/prompt-and-skill-management/concepts.md)). Text and chat prompt types; `{{variable}}` syntax; prompt references (composability); message placeholders for chat history ([concepts](https://langfuse.com/docs/prompt-and-skill-management/concepts.md), [variables](https://langfuse.com/docs/prompt-management/features/variables.md)). Prompts can carry a model config. New in 2026: versioned **Skills** (SKILL.md bundles) managed alongside prompts ([concepts](https://langfuse.com/docs/prompt-and-skill-management/concepts.md)). Protected labels are gated to the Teams add-on/Enterprise ([pricing](https://langfuse.com/pricing)).
- **Runtime fetch:** SDK `get_prompt(name, label)` with a client-side cache. Default TTL is **60 s**, it serves stale while revalidating in the background, the server side has a Redis cache, and there is an optional fallback prompt ([caching](https://langfuse.com/docs/prompt-management/features/caching.md)). Prompt fetches are unlimited on all plans ([pricing](https://langfuse.com/pricing)).
- **Runs agents?** No, it observes them. New: the **Langfuse AI Gateway (public beta)**, an OpenAI/Anthropic-compatible proxy that holds provider keys centrally and supports budgets and model allow-lists. Every call becomes a trace ([gateway overview](https://langfuse.com/docs/gateway/overview.md)). It is a proxy, not an agent loop. **Halo** is an in-app agent for analysing project data, not a runtime for tenant agents ([Halo](https://langfuse.com/docs/api-and-data-platform/features/halo.md)).
- **Chat history:** sessions group traces by `sessionId` (up to 200 chars). The session view supports replay, in-session search, public share links, bookmarks and session-level scores ([sessions](https://langfuse.com/docs/observability/features/sessions.md)). User tracking is available too. **Full-text search** over input, output and metadata uses ClickHouse text indexes (token-based, whole-word). It is in the UI and in the API via the `matches` operator on `/api/public/v2/observations` ([full-text search](https://langfuse.com/docs/observability/features/full-text-search.md)). Custom dashboards and alerts are available ([pricing](https://langfuse.com/pricing)). I found no built-in semantic search or topic clustering in the docs index; the closest is NL analysis via Halo ([llms-docs.txt](https://langfuse.com/llms-docs.txt)).
- **Overlap with Kerby:**
  - Hosted runtime: N.
  - Durable: N.
  - Conversations API: P. It is a read and analytics store of traces, not the system of record the app writes conversations to.
  - History search: Y (full-text, filters, dashboards).
  - Prompt mgmt: Y (same model as Kerby).
  - Tools/MCP: P. Langfuse exposes its _own_ MCP server for data, and does not call tenant tools.
  - BYOK: P (gateway beta, LLM connections for playground and evals).
  - Isolation/self-host: Y (MIT, data regions US/EU/JP/HIPAA).
  - Console: Y.
- **Pricing (Cloud):**
  - Hobby: free, 50k units, 30-day access, 2 users.
  - Core: $29/mo, 100k units, 90 days.
  - Pro: $199/mo, 3-year access, SOC2/HIPAA. Teams add-on is $300/mo.
  - Enterprise: $2,499/mo.
  - Overage is $8 per 100k units, falling to $6 per 100k at 50M+. A unit is a trace, observation or score ([pricing](https://langfuse.com/pricing)).
  - Self-host OSS is free (MIT, "all core features without limitations"). Self-hosted Enterprise is custom and bundled with ClickHouse Cloud/BYOC/Private ([self-host pricing](https://langfuse.com/pricing-self-host.md)).
- **What it does that Kerby doesn't:** evals (LLM-as-judge, annotation queues, datasets, experiments), full-text search, dashboards and alerts, OTel ingestion from any framework, open-source self-host, skills management, and a gateway with budgets.
- **Where Kerby differs:** Kerby executes the loop durably and owns the transcript. Prompts resolve server-side with no cache staleness. Kerby has a per-tenant Postgres DB, remote MCP tool execution, and decision-model guardrails.

### LangSmith (LangChain)

- **What and status:** an observability, evals and prompt platform plus **Agent Server** (managed agent runtime, formerly LangGraph Platform), **Fleet** (no-code agents, formerly Agent Builder), Sandboxes and an LLM Gateway. GA ([pricing](https://www.langchain.com/pricing); [Fleet](https://docs.langchain.com/langsmith/fleet/index.md)).
- **Prompt versioning:** every save is a **commit** with a hash. **Commit tags** are movable pointers. `staging` and `production` are **reserved tags that form "Environments"**; you promote between them, and each environment has a rollback history ([manage prompts](https://docs.langchain.com/langsmith/manage-prompts.md)). Templates are **f-string or mustache**. You can store an optional model config, or push a prompt plus model as a RunnableSequence, and there are StructuredPrompts with output schemas ([concepts](https://docs.langchain.com/langsmith/prompt-engineering-concepts.md); [programmatic](https://docs.langchain.com/langsmith/manage-prompts-programmatically.md)). There is a playground and a Prompt Hub.
- **Runtime fetch:** `client.pull_prompt("name:tag")` or `name:commit`. An SDK global in-memory cache is on by default (max 100 entries, `ttl_seconds=300`, background refresh every 60 s, stale-while-revalidate) ([programmatic](https://docs.langchain.com/langsmith/manage-prompts-programmatically.md)).
- **Runs agents?** Observability itself only observes. **Agent Server** _does_ run agents: assistants, threads and runs, built-in persistence, a task queue, streaming, human-in-the-loop, double-texting handling, cron, webhooks, and exposure over MCP/A2A. You deploy your own LangGraph graph code ([Agent Server](https://docs.langchain.com/langsmith/agent-server.md)). Fleet runs no-code agents ([Fleet](https://docs.langchain.com/langsmith/fleet/index.md)). Appendix B covers Agent Server in depth.
- **Chat history:** **threads** group traces via `thread_id`/`session_id` metadata, which must be set on all child runs ([threads](https://docs.langchain.com/langsmith/threads.md)). Full-text search filters cover inputs and outputs ([filter traces](https://docs.langchain.com/langsmith/filter-traces-in-application.md)). **Insights** samples conversations (a thread is analysed after 10 minutes idle), summarises each one, extracts attributes, and assigns hierarchical categories and subcategories. It has breakdown tables (error rate, latency, cost per category), Slack digests, and uses **the customer's model keys** (summarisation plus categorisation models). It is available on Plus and Enterprise ([Insights](https://docs.langchain.com/langsmith/insights.md)). Data retention: base traces 14 days, extended 180 days ([pricing FAQ](https://www.langchain.com/pricing)).
- **Overlap with Kerby:**
  - Hosted runtime: P (Agent Server, but tenant code).
  - Durable: P (persistence plus task queue; exact-once semantics unverified).
  - Conversations API: Y (Agent Server threads).
  - History search: Y (full-text plus Insights clustering).
  - Prompt mgmt: Y.
  - MCP: P (Agent Server exposes MCP; tool calling is in the graph code).
  - BYOK: Y.
  - Isolation/self-host: self-hosted is an **Enterprise add-on** on Kubernetes with ClickHouse or SmithDB plus Postgres plus Redis plus blob storage ([self-hosted](https://docs.langchain.com/langsmith/self-hosted.md)).
  - Console: Y.
- **Pricing:**
  - Developer: $0, 1 seat, 5k base traces/mo.
  - Plus: $39/seat/mo, 10k base traces, 1 free small serverless Agent Server.
  - Enterprise: custom.
  - Usage is in LSUs at **$1/LSU**. The pricing calculator encodes **0.005 LSU per trace (about $5 per 1k traces)**. Agent Server runtime costs 0.0675 LSU/vCPU-hr plus 0.009 LSU/GiB-hr. Fleet runs cost 0.3, 0.6 or 1.5 LSU depending on tier ([pricing page and embedded calculator](https://www.langchain.com/pricing)).
- **What it does that Kerby doesn't:** conversation clustering (Insights), multi-turn evals, annotation queues, datasets, a sandboxes product, a no-code agent builder, cron, and A2A.
- **Where Kerby differs:** no tenant code (MCP only) versus deploying LangGraph code; BYOK-only; per-tenant Postgres; prompts referenced natively by conversations; simpler pricing (TBD) versus seats plus LSU.

### Braintrust

- **What and status:** an evals and observability platform with prompt deployment, a model Gateway (the old AI proxy is deprecated) and the **Loop** AI agent. GA ([docs index](https://www.braintrust.dev/llms.txt)).
- **Prompt versioning:** every change creates a new version automatically, and apps use the latest by default. You pin a version or **assign versions to environments** (dev, staging, production). The CLI does this with `bt prompts assign my-prompt --version … --environment production` ([versions](https://docs.braintrust.dev/evaluate/prompts/versions.md)). Templating is **Mustache or Nunjucks** ([docs index](https://www.braintrust.dev/llms.txt)). Environments are a Pro feature ([pricing](https://www.braintrust.dev/pricing)).
- **Runtime fetch:** `loadPrompt()`/`load_prompt()` fetches on **every call** and writes a memory and disk cache. That cache is used only as a fallback on transient errors, not for version- or environment-pinned loads. Go does not cache. Alternatively `invoke()` runs the prompt **on Braintrust** with its configured model and logs it ([deploy prompts](https://docs.braintrust.dev/deploy/prompts.md)).
- **Runs agents?** Mostly no. `invoke()` executes a single prompt call. When the prompt has tools, "the response contains tool calls that your code must handle", so there is no hosted tool loop ([deploy prompts](https://docs.braintrust.dev/deploy/prompts.md)).
- **Chat history:** a Logs table of traces. Search supports basic filters, a **SQL `WHERE` editor with full-text search**, and NL-to-SQL via Loop ([filter](https://docs.braintrust.dev/observe/filter.md)). **Topics** runs a daily pipeline: per-trace facet summaries, then **embeddings**, clustering (from about 100 or more summaries), and LLM cluster naming. It uses a Thread preprocessor for conversations, and the hosted models are ZDR ([Topics](https://docs.braintrust.dev/observe/topics/index.md)). **Patterns** has Loop investigate traces on a schedule and record recurring issues ([pricing](https://www.braintrust.dev/pricing)).
- **Overlap with Kerby:**
  - Runtime: P (single call).
  - Durable: N.
  - Conversations API: N.
  - History search: Y (SQL, full-text, semantic clustering).
  - Prompt mgmt: Y.
  - MCP: N for tenant tools (Braintrust has its own MCP server for data) ([docs index](https://www.braintrust.dev/llms.txt)).
  - BYOK: Y.
  - Isolation: SaaS, or **BYOC data plane** (Enterprise), with the control plane always run by Braintrust ([deployment](https://docs.braintrust.dev/admin/deployment/index.md)).
  - Console: Y.
- **Pricing:**
  - Starter: $0. 1 GB processed data, then $4/GB; 10k scores, then $2.50/1k; 14-day retention; unlimited users.
  - Pro: $249/mo. 5 GB, then $3/GB; 50k scores, then $1.50/1k; 30-day retention, then $0.50/GB/mo.
  - Enterprise: custom.
  - Credits (10 and 100 per month) cover Topics and Loop ([pricing](https://www.braintrust.dev/pricing)).
- **What it does that Kerby doesn't:** best-in-class evals and experiments, SQL over logs, Topics clustering, the Loop agent, and Terraform for prompts.
- **Where Kerby differs:** Kerby runs the full tool loop durably and stores conversations as primary data.

### PromptLayer

- **What and status:** a prompt registry plus observability plus evals ("Tables"), visual Workflows, and Skill Collections. GA ([docs index](https://docs.promptlayer.com/llms.txt)).
- **Prompt versioning:** versioned prompt templates. **Release Labels** (e.g. `prod`, `staging`) are attached to versions. **Dynamic Release Labels / A/B Releases** split a label's traffic by percentage or by user segment ([release labels](https://docs.promptlayer.com/features/prompt-registry/release-labels.md); [dynamic labels](https://docs.promptlayer.com/features/prompt-registry/dynamic-release-labels.md)). Templates are **f-string or Jinja2**, with reusable "Input Variable Sets" ([template variables](https://docs.promptlayer.com/features/prompt-registry/template-variables.md)). Deployment Approvals are Enterprise-only ([pricing](https://www.promptlayer.com/pricing)).
- **Runtime fetch:** `pl_client.run(prompt_name, input_variables, prompt_release_label="prod")`, or GET the template. PromptLayer recommends **webhook-driven local caching** or GitOps sync to remove the round trip ([deployment strategies](https://docs.promptlayer.com/onboarding-guides/deployment-strategies.md)).
- **Runs agents?** Partially, and this is the closest of the group:
  - **Managed MCP servers**: you register an HTTPS MCP URL once per workspace, and auth headers must reference **encrypted workspace environment variables**. PromptLayer discovers the tools, translates them for any provider, **executes tool calls and continues the tool-calling loop**. MCP config is a live mutable reference, not versioned ([MCP servers](https://docs.promptlayer.com/features/mcp-servers/overview.md)).
  - **Managed Workflows** "let PromptLayer orchestrate everything server-side". They are DAGs with For/While loops, branching, and a sandboxed "Coding Agent" node, triggered via the Run Workflow API ([workflows](https://docs.promptlayer.com/why-promptlayer/workflows.md); [deployment strategies](https://docs.promptlayer.com/onboarding-guides/deployment-strategies.md)).
  - Durable or exactly-once semantics: unverified.
- **Chat history:** request logs plus traces. Search uses structured filters plus content fields: Input Text, Output Text, Input Variable, **User Intent, Agent Intent**, tool name, and span-level filters. There is a Search Request Logs API and Analytics charts over filtered sets ([search](https://docs.promptlayer.com/features/search-and-analytics/search.md)). "Signals" are automated yes/no assertions with reasoning on production logs ([docs index](https://docs.promptlayer.com/llms.txt)), which is conceptually near Kerby's decision models but post hoc. I found no first-class thread/session object or semantic search in the docs index.
- **Overlap with Kerby:**
  - Runtime: P/Y (server-side MCP loop and workflows).
  - Durable: unverified.
  - Conversations API: N.
  - History search: Y (content search).
  - Prompt mgmt: Y (plus A/B).
  - MCP: **Y (remote MCP plus encrypted secrets, Kerby-like)**.
  - BYOK: Y (provider keys in workspace; exact mechanics unverified).
  - Isolation: Enterprise self-host on GCP/AWS/Azure, EU cloud, or single-tenant cloud ([pricing FAQ](https://www.promptlayer.com/pricing)).
  - Console: Y (aimed at PMs and domain experts).
- **Pricing:**
  - Free: $0, 5 users, 2.5k requests/mo, 10 prompts.
  - Pro: $49/mo, overage $0.003/txn.
  - Team: $500/mo, 25 users, 100k+ requests, $0.002/txn.
  - Enterprise: custom (RBAC, approvals, self-host, SSO).
  - Requests, agent node executions and eval cells are all billed as transactions ([pricing](https://www.promptlayer.com/pricing)).
- **What it does that Kerby doesn't:** A/B label routing, visual workflow builder, evals and batch runs, webhooks on prompt changes, skill collections.
- **Where Kerby differs:** Kerby has durable conversation-centric runs with SSE, transcript storage and paged reads per end user, per-tenant DB isolation, and versioned prompts bound to conversations. PromptLayer's MCP config being mutable is also a governance difference.

### Vellum

- **What and status:** formerly an LLMOps developer platform (prompt deployments, Workflows, Agent Node, evals, RAG). The homepage now sells "Vellum: Your Personal Intelligence", a personal assistant ([vellum.ai](https://www.vellum.ai/)), with pricing at $30, $100 or $200/mo ([pricing](https://www.vellum.ai/pricing)). The **Personal Assistant Platform is shutting down**: cloud assistants are turned off from **2026-11-07**, and logins and data end on **2026-12-13** ([shutdown notice](https://www.vellum.ai/vellum-assistant-platform-shutdown)). The pivot date (June 2026, $25M raise) comes from secondary sources ([aiworkflowsforbusiness](https://www.aiworkflowsforbusiness.com/vellum-vs-gumloop)). The **status of the developer platform is unverified**: the docs are still online, there is no official discontinuation notice, and the old product pages redirect ([zenml summary](https://www.zenml.io/blog/vellum-alternatives); [eesel](https://www.eesel.ai/blog/vellum-ai-pricing)). Treat it as not a viable current competitor.
- **Prompt versioning (legacy docs):** Prompt/Workflow **Deployments** have a separate release history per **Environment**. You use the `LATEST` tag or custom semver **Release Tags**. Release Reviews gate promotion. Templating is Jinja ([release tags](https://docs.vellum.ai/product/deployments/release-tags.md); [environments](https://docs.vellum.ai/product/deployments/environments.md); [prompt engineering](https://docs.vellum.ai/product/prompts/prompt-engineering.md)).
- **Runs agents?** Yes, historically: Workflows run hosted, and the Agent Node handles the tool-calling loop ([docs index](https://docs.vellum.ai/llms.txt)). Self-host was an Enterprise option, including air-gapped ([self-hosted](https://docs.vellum.ai/self-hosting/getting-started/introduction.md)).
- **Chat history:** execution monitoring, filtering via API, Datadog and webhooks ([docs index](https://docs.vellum.ai/llms.txt)). No thread search was verified.
- **Overlap with Kerby:** high on paper (hosted runtime, prompts, environments, console), but the company has exited the market. Durable execution, MCP and BYOK are unverified.
- **Pricing:** developer platform pricing is no longer published (unverified).
- **Takeaway:** a cautionary case. A visual workflow-plus-prompt-deployment platform could not hold the developer market.

### Humanloop

- **What and status:** a prompt management and evals platform. **Sunset on 2025-09-08** after the Anthropic deal. Users were notified on 2025-07-17 and billing stopped on 2025-07-30. After the sunset date the platform and data became permanently inaccessible ([Humanloop changelog Aug 2025](https://humanloop.com/docs/changelog/2025/08); [migration guide](https://humanloop.com/docs/guides/migrating-from-humanloop)). Secondary sources say it was an acqui-hire (founders plus about a dozen staff joined Anthropic on 2025-08-13) and that Anthropic did not buy assets or IP ([startups.center](https://startups.center/w/humanloop-2025-anthropic-acquihire-sunset)).
- **Overlap with Kerby:** none today. Its customers were redistributed: W&B published migration reports ([W&B report](https://wandb.ai/wandb_fc/product-announcements-fc/reports/Humanloop-is-sunsetting-Migrate-to-Weights-Biases-as-an-alternative--VmlldzoxMzk4ODc1Nw)).

### Portkey

- **What and status:** an AI gateway plus observability plus Prompt Engineering Studio plus MCP Gateway. **Acquired by Palo Alto Networks.** The deal was announced 2026-04-30 and closed 2026-05-29 for about $140M; these details come from secondary sources and I did not verify them against an SEC filing ([druce.ai](https://druce.ai/governance/wiki/vendors/portkey); [incyber](https://incyber.org/en/article/palo-alto-networks-announced-on-june-2-2026-the-acquisition-of-portkey-a-u-s-start-up-specializing-in-the-control-of-autonomous-ai-agents/)). First-party evidence: portkey.ai/pricing redirects to Palo Alto's "Prisma AIRS AI Gateway", which cites portkey.ai data and was "generally available starting July 16, 2026" ([PANW AI Gateway](https://www.paloaltonetworks.com/ai-security/ai-gateway)). Portkey docs now have a "Prisma AIRS" docs version, and the Enterprise CTA links to PANW ([docs index](https://portkey.ai/docs/llms.txt); [feature comparison](https://docs.portkey.ai/docs/product/product-feature-comparison.md)).
- **Prompt versioning:** every **Update** saves a new version. **Publish** makes one version the default "production" version. Labels deploy specific versions to environments ([versioning & labels](https://docs.portkey.ai/docs/product/prompt-engineering-studio/prompt-versioning.md)). There are Prompt Partials (reusable snippets) and mustache templating ([docs index](https://docs.portkey.ai/docs/_llms/latest/docs.txt); [launch blog](https://portkey.ai/blog/prompt-engineering-studio/)).
- **Runtime fetch:** `POST /prompts/{id}/completions` **executes** the saved prompt server-side (retrieve, then fill variables, then call the model), or `/prompts/{id}/render` returns the filled template ([Prompt API](https://docs.portkey.ai/docs/product/prompt-engineering-studio/prompt-api.md)).
- **Runs agents?** No agent loop. It runs single completions through the gateway. The **MCP Gateway** centralises auth, access control, tool provisioning, guardrails and logging for MCP servers used by _your_ agents ([docs index](https://docs.portkey.ai/docs/_llms/latest/docs.txt)).
- **Decision API (notable):** `/v1/decisions` returns **typed judgments** (probability, choice or score) per question. It works across providers ("Jev shape" for Workers AI/TypeSafe/OpenRouter, OpenAI shape for OpenAI/Azure), with no streaming, and guardrails can screen the judged content ([Decisions](https://docs.portkey.ai/docs/product/ai-gateway/decisions-api.md); [Decisions guardrails](https://docs.portkey.ai/docs/product/guardrails/decisions-guardrails.md)). This is the closest analogue in this segment to Kerby's decision models, but as a stateless API rather than a guardrail inside the agent loop.
- **Chat history:** a request Logs list, Traces, metadata filters and exports ([docs index](https://docs.portkey.ai/docs/_llms/latest/docs.txt)). I did not verify a thread/session-level view or semantic search.
- **Overlap with Kerby:**
  - Runtime: P (single calls).
  - Durable: N.
  - Conversations API: N.
  - History search: P.
  - Prompt mgmt: Y.
  - MCP: Y (gateway, governance).
  - BYOK: Y (Model Catalog integrations, workload identity federation).
  - Isolation: open-source gateway; Enterprise hybrid (data plane in customer VPC) or full self-host ([feature comparison](https://docs.portkey.ai/docs/product/product-feature-comparison.md)).
  - Console: Y.
- **Pricing:**
  - Dev: free, 10k requests/mo, 3-day log retention, 3 prompt templates.
  - Pro: $49/mo, 100k requests, then $9 per 100k up to 3M, 30-day retention.
  - Enterprise: custom, now sold via PANW.
  - Open-source gateway: unlimited ([feature comparison](https://docs.portkey.ai/docs/product/product-feature-comparison.md)).
- **What it does that Kerby doesn't:** gateway routing, fallbacks and caching across 1,600+ models, budgets and rate limits, guardrails, MCP governance, and security positioning under PANW.
- **Where Kerby differs:** Kerby runs stateful, durable agent conversations. Portkey is a stateless proxy and control plane. Its new owner is pushing it toward enterprise security rather than developer runtime.

### Helicone

- **What and status:** an open-source LLM observability tool plus AI gateway. **Acquired by Mintlify on 2026-03-03.** It is in **maintenance mode** (security fixes, bug fixes, new models), and Mintlify says it will help customers migrate to another platform ([Mintlify blog](https://www.mintlify.com/blog/mintlify-acquires-helicone)). Its site banner currently says "Helicone is now part of **Experiential Labs**. Details to come soon" ([helicone.ai/pricing](https://www.helicone.ai/pricing)). The relationship between Experiential Labs and Mintlify is unverified.
- **Prompt versioning:** "Prompts 2025" API. Versions are tracked with compare and rollback, and versions are deployed per **environment** (production, staging, development). Variables use `{{hc:name:type}}` and are usable even in tool schemas ([prompts overview](https://docs.helicone.ai/features/advanced-usage/prompts/overview.md)).
- **Runtime fetch:** prompts are compiled at the **AI Gateway** (prompt id plus environment plus inputs in the request), or via the SDK without the gateway ([docs index](https://docs.helicone.ai/llms.txt)).
- **Runs agents?** No. It is a proxy plus logging.
- **Chat history:** sessions via `Helicone-Session-Id`/`-Path`/`-Name` headers ([sessions](https://docs.helicone.ai/features/sessions.md)). There are Query Sessions and session-metrics APIs, user analytics, and **HQL** (SQL over analytics with row-level security) ([docs index](https://docs.helicone.ai/llms.txt)).
- **Overlap with Kerby:**
  - Runtime: N.
  - Durable: N.
  - Conversations API: P (session query).
  - Search: P (HQL).
  - Prompt mgmt: Y.
  - MCP: N.
  - BYOK: Y (gateway).
  - Self-host: Y (Docker, Helm) ([docs index](https://docs.helicone.ai/llms.txt)).
  - Console: Y.
- **Pricing:**
  - Hobby: free, 10k requests, 1 GB.
  - Pro: $79/mo.
  - Team: $799/mo.
  - Usage-based beyond those ([pricing](https://www.helicone.ai/pricing)).
- **Takeaway:** a sunsetting product. Its customers are a migration pool.

### Arize Phoenix and Arize AX

- **What and status:** **Phoenix** is open source (Elastic License 2.0; free to self-host) and covers OTel tracing, evals and prompt management ([license](https://arize.com/docs/phoenix/self-hosting/license.md)). **Arize AX** is the commercial SaaS or self-host platform, with the Alyx agent and Signal. Both are GA ([pricing](https://arize.com/pricing/), modified 2026-09-01).
- **Prompt versioning:**
  - Phoenix: saved prompts get **immutable, undeletable version IDs** and **tags** (unique per prompt, e.g. `staging`). You pull by name (latest), by version ID or by tag ([using a prompt](https://arize.com/docs/phoenix/prompt-engineering/how-to-prompts/using-a-prompt.md)).
  - AX Prompt Hub: "each Save Prompt writes the next immutable version". Tags or labels such as **Production** resolve at inference time, so you can deploy without a redeploy ([save & version](https://arize.com/docs/ax/improve/save-and-version-prompts); [concepts](https://arize.com/docs/ax/concepts/prompts/overview)).
  - Both have a playground, span replay and prompt optimisation (Prompt Learning, DSPy-style) ([Phoenix docs index](https://arize.com/docs/phoenix/llms.txt)).
- **Runtime fetch:** SDK `client.prompts.get(prompt_identifier, tag=…)` ([using a prompt](https://arize.com/docs/phoenix/prompt-engineering/how-to-prompts/using-a-prompt.md)). Client caching behaviour is unverified.
- **Runs agents?** No for production. "Agent Experimentation: run your agent in playground" is listed for AX ([pricing](https://arize.com/pricing/)). Alyx and "Custom Managed Agents" are Arize's own analysis agents.
- **Chat history:** sessions in both. Phoenix has filter expressions over spans and sessions, including session aggregates ([Phoenix docs index](https://arize.com/docs/phoenix/llms.txt)). AX made sessions "a first-class unit of work" (annotate and queue sessions, session evals) in 2026-09 ([AX blog](https://arize.com/blog/new-in-arize-ax-september-2026-updates/)). **Signal** scans traces on a schedule, **groups recurring failure patterns into issues**, and writes investigations ([Signal](https://arize.com/docs/ax/observe/signal)). Signal issues are metered: 10/25/unlimited per month ([pricing](https://arize.com/pricing/)).
- **Overlap with Kerby:**
  - Runtime: N.
  - Durable: N.
  - Conversations API: P (sessions, read-side).
  - Search/analytics: Y (filters, Signal clustering, dashboards).
  - Prompt mgmt: Y.
  - MCP: N.
  - BYOK: P (AX Enterprise "Bring your own key" for its own AI features).
  - Self-host: Phoenix free (ELv2, not OSI); AX Enterprise self-hosted.
  - Console: Y.
- **Pricing (AX):**
  - Free: 25k spans/mo, 1 GB, 15-day retention.
  - Pro: $50/mo, 50k spans, 10 GB, 30 days.
  - Enterprise: custom, SaaS or self-hosted ([pricing](https://arize.com/pricing/)).
- **What it does that Kerby doesn't:** eval depth (session and trajectory evals, agent-as-judge), Signal issue detection, prompt optimisation, multimodal tracing. AX also has "Decision Judges", per the Alyx update ([Arize blog](https://arize.com/blog/alyx-gets-better-at-doing-thingss/)), a naming parallel to Kerby's decision models; I did not verify the details.

### Weights & Biases Weave → CoreWeave Forge / Agent Lens

- **What and status:** W&B (acquired by CoreWeave) is now **CoreWeave Forge**, announced 2026-09-30 and combining W&B, OpenPipe and marimo ([CoreWeave press](https://www.coreweave.com/news/coreweave-forge-launches-turning-the-ai-loop-production-run-into-a-better-model-and-agent); [Forge](https://www.coreweave.com/products/coreweave-forge)). Weave continues under docs.coreweave.com. **Agent Lens**, "the successor to Weights & Biases Weave", is in **public preview** and receives the same tracing data ([Weave docs](https://docs.coreweave.com/products/wandb/weave); [What is Agent Lens](https://docs.coreweave.com/products/agent-lens/what-is-agent-lens.md)).
- **Prompt versioning:** prompts are Weave objects (`StringPrompt`, `MessagesPrompt`, or a subclass with a custom `format`). `weave.publish` creates an **immutable version**. You reference it as `name:vN`, by hash, or by alias (`:latest` always exists, `:production`) using `weave.ref(...).get()` ([prompts](https://docs.coreweave.com/products/wandb/weave/guides/core-types/prompts.md); [prompt versions](https://docs.coreweave.com/products/wandb/weave/guides/core-types/prompts-version.md)). It is code-first: no label-promotion UI comparable to Langfuse was verified.
- **Runs agents?** No.
- **Chat history:** Weave **Threads** group calls by `thread_id` with turns and conversation-level metrics ([threads](https://docs.coreweave.com/products/wandb/weave/guides/tracking/threads)). Agent Lens adds session and multi-turn views, aggregated insights, custom behaviour "tags", and is OTel GenAI-semconv native ([Agent Lens](https://docs.coreweave.com/products/agent-lens/what-is-agent-lens.md)). CoreWeave markets it as clustering "the conversations that break the same way" ([CoreWeave on X](https://x.com/CoreWeave/status/2105359436826960301), secondary).
- **Overlap with Kerby:** runtime N; durable N; conversations API P (threads); search/insights P/Y (Agent Lens); prompt mgmt P (versioned objects plus aliases); MCP N; isolation is Enterprise private connectivity/CMEK (unverified for self-host); console P (ML-engineer audience).
- **Pricing (Forge):**
  - Free: $0, 1 GB/mo of Weave ingestion.
  - Pro: from $60/mo, 1.5 GB of ingestion, then $0.10/MB.
  - Enterprise: custom, $0.20/MB for extra ingestion, HIPAA, CMEK, SSO ([Forge pricing](https://www.coreweave.com/forge-pricing)).
- **Takeaway:** it is becoming part of a GPU-cloud training loop (production traces feed RL/fine-tuning). That is adjacent to Kerby's buyer, not head-on.

### Agenta

- **What and status:** formerly an open-source (MIT) prompt management, evals and observability platform. On **2026-07-21** it announced "**Agenta Is Now a Workspace for Building Agents**": agents made of instructions, tools (built-in integrations plus **MCP servers**), skills, permissions and files. They run in chat or as scheduled or triggered automations, on a selectable **harness (Claude Code, Pi, and later Codex)**, with versioned configuration and traced runs ([changelog](https://agenta.ai/docs/changelog/agenta-is-now-a-workspace-for-building-agents); [docs index](https://agenta.ai/docs/llms.txt)). GA cloud plus OSS.
- **Prompt versioning (legacy "1.0" docs, still published):** git-like. Each **variant** is a branch with an immutable commit history. **Environments** (development, staging, production) point at a specific version and keep deployment history for rollback. Templates support Jinja2 ([concepts](https://agenta.ai/docs/1.0/prompt-engineering/concepts); [docs index](https://agenta.ai/docs/llms.txt)). There is an SDK/API fetch from environments ([fetch prompts](https://agenta.ai/docs/1.0/prompt-engineering/integrating-prompts/fetch-prompt-programatically)). Caching details are unverified.
- **Runs agents?** **Yes, now.** "Agents get their own computer and browser", there are concurrent tasks (2, 20 or 50 by plan), and a task is "one agent turn" ([pricing](https://agenta.ai/pricing)). Durability and exactly-once semantics are unverified.
- **Chat history:** chat sessions in observability with cost analytics. The sidebar lets you group, filter and pin sessions ([docs index](https://agenta.ai/docs/llms.txt)). No full-text or semantic search was verified.
- **Overlap with Kerby:**
  - Runtime: **Y**.
  - Durable: unverified.
  - Conversations: Y (sessions).
  - Search: P.
  - Prompt mgmt: P (legacy prompts plus versioned agent config).
  - MCP: **Y**.
  - BYOK: **Y**. Project provider keys or a ChatGPT subscription; BYOK model use costs no credits but runtime still does ([pricing](https://agenta.ai/pricing); [docs index](https://agenta.ai/docs/llms.txt)).
  - Self-host: **Y**, MIT, Docker Compose.
  - Console: Y.
- **Pricing:**
  - Hobby: $0, 500 bonus credits plus 75/day on up to 10 days.
  - Starter: $29/mo, 2,900 credits.
  - Business: $299/mo, 32,000 credits.
  - Extra credits are 1,000 for $10. One hour of runtime is about 50 credits ([pricing](https://agenta.ai/pricing)).
- **Where Kerby differs:** Agenta is end-user/team-facing ("agents for your daily work", Slack/Telegram publishing, sandboxed computer) and harness-based, running Claude Code or Pi in sandboxes. Kerby is a multi-tenant API for developers embedding agents in their own products: `externalUserId`, SSE, per-tenant DB, no tenant code. **This is the closest pivot toward Kerby's space in the segment.** Worth tracking.

### Latitude

- **What and status:** an MIT open-source platform. **V2 (2026) is "an observability and signal-discovery platform for agents you run yourself"**. **The V1 prompt manager (PromptL) and AI gateway were sunset on 2026-10-30.** `prompts.run()`/`chat()` stopped serving, and "nothing on the Latitude side replaces them" ([migrate from V1](https://docs.latitude.so/getting-started/migrate-from-v1.md)).
- **Prompt versioning:** **none in V2.** Prompts move into the customer's codebase and git. Versions are tracked only as trace metadata (`metadata.prompt_version`, release tags) ([migrate from V1](https://docs.latitude.so/getting-started/migrate-from-v1.md)). V1 had drafts, published versions and PromptL `{{ var }}` (same source).
- **Runs agents?** No (V2 removed it).
- **Chat history:** traces (one per turn), **sessions** (conversations), **users** pages, tools, memory and cost views ([docs index](https://docs.latitude.so/llms.txt)). **Search: semantic search is the default**, finding traces by meaning (e.g. "user is frustrated"), plus quoted exact text, combined with filters and saved searches. It covers 100% of ingested traces within retention ([search](https://docs.latitude.so/search/overview.md)). Signals group failed scores. Importers exist for Langfuse, LangSmith and Braintrust ([docs index](https://docs.latitude.so/llms.txt)).
- **Overlap with Kerby:** runtime N; durable N; conversations P (sessions, users); **history search Y (semantic plus exact, the feature Kerby lacks)**; prompt mgmt N; MCP N (Latitude exposes its own MCP); self-host Y (MIT); console Y.
- **Pricing:**
  - Starter: free, 20k credits/mo, 30-day retention, unlimited seats.
  - Pro: $99/mo, 100k credits, 90 days, $20 per extra 10k.
  - Enterprise: custom, on-prem ([pricing](https://latitude.so/pricing)).
- **Takeaway:** strong evidence that a hosted prompt-runner on the critical path was a hard sell for Latitude. Their semantic search over sessions is a concrete spec for what Kerby's "not built yet" search could look like.

### Pezzo

- **What and status:** an open-source "developer-first LLMOps platform" (prompt design, versioning, instant delivery, observability). The repo is not archived, but the **last release was v0.9.2 on 2024-05-15**. 2026 commits are sporadic fixes (2026-08-21, 2026-11-08) ([GitHub API: repo](https://api.github.com/repos/pezzolabs/pezzo), [commits](https://api.github.com/repos/pezzolabs/pezzo/commits), [releases](https://api.github.com/repos/pezzolabs/pezzo/releases/latest)). pezzo.ai did not respond to HTTP requests on 2026-11-23 (my observation). Effectively dormant, so not a competitor.
- **Overlap with Kerby:** prompt versioning and delivery only. Pricing: none published (unverified).

## Appendix D: Adjacent layers: memory, tool auth, sandboxes, business platforms

_Report title: Adjacent layers: memory/history services, tool/MCP infrastructure, sandboxes, business agent platforms (as of 2026-11-23)_

Axis key used per player: **Runtime** = hosted agent runtime (runs the loop) · **Durable** = durable/resumable execution · **Threads** = stored conversations/threads API · **Query** = querying/search over history · **Prompts** = prompt management · **Tools** = tools/MCP · **BYOK** = BYOK/model choice · **Isolation** = tenant isolation/residency/self-host · **Console** = UI for non-engineers.

### Segment summary

- **Nobody in the memory segment runs the agent loop.** Zep, Mem0 and Supermemory are sidecars: you push messages in and pull context out. They complement Kerby more than they replace it, but each one offers the history search Kerby hasn't built: semantic, keyword and graph search; temporal facts; user profiles. A Kerby tenant who wants "search my users' chat history" today would put one of these beside Kerby.
- **Zep is closest to Kerby's chat-history feature.** It has users → threads → messages with paged `list_messages` ([docs](https://help.getzep.com/threads)), keeps raw history, and builds a temporal context graph on top. Since late 2026 it sells itself as an "enterprise context layer" (Context Lake, Agent Skills) more than as chat memory ([getzep.com](https://www.getzep.com/)). Mem0 and Supermemory store extracted _memories_, not full verbatim transcripts with a run trace.
- **Memory pricing is metered on ingestion, and retrieval is cheap or free.** Zep: 350-byte episode credits, retrieval and storage free ([pricing](https://www.getzep.com/pricing)). Supermemory: $5/1M tokens ingested, $5/1M searches ([pricing](https://supermemory.ai/pricing)). Mem0 dropped public tiers on 2026-10-26 and now offers only Free or Custom; the date comes from a secondary source ([hokai.io](https://hokai.io/hub/tools/mem0)) and the current page is [mem0.ai/pricing](https://mem0.ai/pricing). That is a ready reference point if Kerby ever charges for history search.
- **Tool/MCP infrastructure is consolidating fast.** Arcade acquired Smithery (2026-08-05) and shut down Smithery's hosting, proxy and managed identity on 2026-10-31 ([arcade blog](https://www.arcade.dev/blog/smithery-joins-arcade/), [smithery.ai/future](https://smithery.ai/future)). Klavis pivoted to RL environments and deprecated its MCP repo ([klavis.ai](https://www.klavis.ai/), [GitHub](https://github.com/Klavis-AI/klavis)). Workday closed its Pipedream acquisition ([Workday Q4 FY26](https://newsroom.workday.com/2026-02-24-Workday-Announces-Fiscal-2026-Fourth-Quarter-and-Full-Year-Financial-Results)). The independents still standing are Composio, Arcade, Nango, Merge Agent Handler and Pipedream (Workday).
- **Per-end-user OAuth is the thing these vendors do that Kerby doesn't.** All of them key credentials to an end-user ID: Composio `userID`, Pipedream `x-pd-external-user-id`, Arcade user auth challenges, Nango connections. They host the consent flow, store and refresh tokens, and inject them per call. Kerby only stores one auth per tenant-registered MCP server, so a Kerby tenant that needs "act as _my_ user in _their_ Gmail" will plug Composio, Arcade or Pipedream in as an MCP server behind Kerby. That makes them complements and likely integration partners.
- **Composio's "Firewall" uses "decision models" to check tool requests and results against policies** ([platform pricing](https://composio.dev/pricing/platform)). That is the same term, and nearly the same feature, as Kerby's decision-model guardrails on tool calls. It overlaps directly with a Kerby differentiator.
- **Sandbox vendors are moving up-stack.** E2B's 2026-10-16 post "Sandboxes are dead" repositions it as an "agent-driven private cloud" ([e2b.dev](https://e2b.dev/resources/sandboxes-are-dead)). Daytona markets itself as an "Agent Cloud" with persistent, indefinitely running sandboxes ([daytona.io](https://www.daytona.io/)). Modal made VM Sandboxes GA ([blog](https://modal.com/blog/vm-sandboxes-agent-computers)). None of the three yet runs an LLM loop with stored conversations as a product. They sell compute for agents, not an agent runtime API. They are the most likely future entrants because they already hold long-lived agent state.
- **Business agent platforms (Dust, Relevance, Voiceflow, Botpress, Stack AI, Sierra, Decagon) host agents and conversations, but for builders inside a company or for CX teams.** Pricing is per seat, per conversation or per outcome; agents are built in a no-code UI; models are bundled. Dust has a Conversation API, but it is an add-on to a seat-priced workspace product ([pricing](https://dust.tt/home/pricing)). None is an API-first, BYOK-only runtime where the developer's app owns the UX. They compete for the same budget only when a company would otherwise build a support bot on Kerby.
- **Closest to Kerby in this segment:**
  - Zep, on chat history plus querying.
  - Letta, on a hosted stateful-agent runtime with memory and BYOK (in more depth in Appendix B).
  - Dust, for a hosted runtime with conversations, an API, MCP, EU/US residency and single-tenant deployment, but seat-priced and aimed at business users.

---

### A. Memory / chat-history-as-a-service

#### Zep (Zep Cloud) + Graphiti

- **What / status:** Zep now calls itself "the enterprise context layer for reliable agents": a Context Lake of governed context graphs plus Agent Skills, which are skills built from agent run traces ([getzep.com, read 2026-11-23](https://www.getzep.com/)). GA, SOC 2 Type II, HIPAA BAA on Enterprise ([pricing](https://www.getzep.com/pricing)). Graphiti is Zep's open-source (Apache-2.0) temporal knowledge-graph framework, ~33k GitHub stars ([GitHub](https://github.com/getzep/graphiti)).
- **Ingestion:**
  - Create a user, then a thread for that user, then call `thread.add_messages`. This appends the messages to the thread history _and_ ingests them into the user's Context Graph, which spans all of that user's threads. Zep assigns the thread UUID; the caller can't choose it, and threads have no metadata field ([threads docs](https://help.getzep.com/threads)).
  - Any JSON or text "episode" can also be ingested ([pricing FAQ](https://www.getzep.com/pricing)).
  - Connectors: Drive, Slack, Notion, Gmail, Granola; Enterprise adds Teams, SharePoint, Snowflake, Databricks and BigQuery ([pricing](https://www.getzep.com/pricing)).
- **Query:**
  - `thread.list_messages` with cursor paging and asc/desc ordering, plus `thread.message.get` ([docs](https://help.getzep.com/threads)).
  - Thread summaries and context retrieval ([docs index](https://help.getzep.com/threads)).
  - Graph search is hybrid (semantic + BM25 keyword + graph traversal). Facts carry validity windows, so "what was true at time T" is queryable ([Graphiti README](https://github.com/getzep/graphiti)).
  - Sub-200 ms retrieval claimed for Zep ([Graphiti README](https://github.com/getzep/graphiti)).
  - Analytics on Flex Plus ([pricing](https://www.getzep.com/pricing)).
- **Axes:**
  - Runtime: no ("works with any agent, model, or harness" via MCP or SDKs, [home](https://www.getzep.com/)).
  - Durable: no.
  - Threads: **yes**.
  - Query: **yes** (semantic, keyword, graph, temporal). It has no full-text search over raw transcripts as a product surface: unverified.
  - Prompts: no. "Agent Skills" are learned procedures, not versioned prompts.
  - Tools: partial (Context MCP Server seats).
  - BYOK: n/a. Zep runs its own extraction models; Graphiti is BYO LLM.
  - Isolation: Cloud, Cloud with customer encryption keys, or BYOC in the customer's VPC (Enterprise). DPA for EU customers. Data residency regions: unverified ([pricing](https://www.getzep.com/pricing)).
  - Console: dashboard with graph visualization and logs ([Graphiti README](https://github.com/getzep/graphiti)). Aimed at developers.
- **Pricing** ([pricing](https://www.getzep.com/pricing)):
  - Free: 10k credits/mo.
  - Flex: $125/mo for 50k credits, then $25 per 10k.
  - Flex Plus: $375/mo for 200k credits, then $75 per 40k.
  - Enterprise: custom.
  - Credit metering: 1 credit per episode up to 350 bytes, +1 per additional 350 bytes. Retrieval, storage, threads, users and graph storage cost 0 credits.
  - Agent Skills are free until 2027-01-04.
- **Retention:** storage isn't charged. API logs are kept 1 day (Flex), 7 days (Flex Plus) or 1 year (Enterprise) ([pricing](https://www.getzep.com/pricing)). A message retention/TTL policy is not published: unverified.
- **Zep does, Kerby doesn't:** temporal knowledge graph over history; cross-thread user memory; semantic, graph and keyword retrieval; enterprise data connectors; BYOC.
- **Kerby differs:** it runs the loop and owns the transcript, including SSE replay and the full run trace with tool calls. It has prompt versioning, a database per tenant, and pg_dump export.

#### Mem0 (Platform, OSS, OpenMemory)

- **What / status:** a managed memory layer: add messages, Mem0 extracts facts and links entities, and recall returns the relevant memories ([docs](https://docs.mem0.ai/platform/overview)). GA. The pricing page now offers only **Free** and **Custom** ([mem0.ai/pricing](https://mem0.ai/pricing)). The change date of 2026-10-26, with legacy Starter/Growth/Pro no longer sold, comes from a secondary source ([hokai.io](https://hokai.io/hub/tools/mem0)).
- **Ingestion:** `add` with messages, scoped by `user_id`, `agent_id`, `run_id`, and `app_id` (Platform only, used for app/tenant separation). Multimodal input, custom categories, `expiration_date` ([platform vs OSS](https://docs.mem0.ai/platform/platform-vs-oss)).
- **Query:**
  - `search`, `get_all`, per-memory `history`, AND/OR/NOT filters over an allowlist of fields, and `get_summary`.
  - Graph memory (entity linking), memory decay, temporal reasoning and "Dream" consolidation are Platform-only. OSS lost its graph-store integration in v3.
  - Project-wide event feed: `GET /v1/events/`.
  - Webhooks and structured memory export jobs ([platform vs OSS](https://docs.mem0.ai/platform/platform-vs-oss)).
- **Axes:**
  - Runtime: no.
  - Durable: no.
  - Threads: partial. It stores extracted memories, not a full transcript API.
  - Query: **yes** (semantic + filters + graph).
  - Prompts: no.
  - Tools: MCP via OpenMemory or integrations.
  - BYOK: **yes**. Free tier with your own LLM key gives 50k adds and 10k retrievals/mo ([pricing](https://mem0.ai/pricing)). OSS supports 18 LLM providers and 25 vector stores ([docs](https://docs.mem0.ai/platform/platform-vs-oss)).
  - Isolation: OSS self-host; on-prem on Custom ([pricing](https://mem0.ai/pricing)).
  - Console: `app.mem0.ai` dashboard ([docs](https://docs.mem0.ai/platform/platform-vs-oss)).
- **Pricing** ([mem0.ai/pricing](https://mem0.ai/pricing)):
  - Free: unlimited end users. First 30 days: 10k adds and 1k retrievals/mo with model calls paid by Mem0. With your own key: 50k adds and 10k retrievals/mo. Usage billing above that, with a cap you set.
  - Custom: graph memory, user profiles, Dream, advanced analytics, SSO/audit/SLA, on-prem.
- **OpenMemory:** a local MCP memory server for Claude, Cursor and other MCP clients ([mem0 blog](https://mem0.ai/blog/introducing-openmemory-mcp)). Secondary sources report a sunsetting notice that points users to the Mem0 self-hosted server ([mcpworld](https://www.mcpworld.com/en/detail/3d6fdbcbc8df63dcb134e2b909e49c5a)). The `openmemory/` directory in mem0ai/mem0 `main` is now empty ([GitHub](https://github.com/mem0ai/mem0/tree/main/openmemory)). Status: likely sunset; no first-party notice found.
- **Retention:** per-memory `expiration_date` and memory decay ([docs](https://docs.mem0.ai/platform/platform-vs-oss)).
- **Mem0 does, Kerby doesn't:** extraction, deduplication and consolidation of facts; semantic recall across sessions; decay.
- **Kerby differs:** it keeps verbatim transcripts and traces and runs the agent.

#### Supermemory

- **What / status:** "Context infrastructure for AI agents." It offers a memory graph per user (profiles, fact hierarchies), SuperRAG (multimodal extraction and chunking), connectors, and plugins for Claude Code, Cursor and Codex ([docs](https://supermemory.ai/docs), [pricing](https://supermemory.ai/pricing)). GA. SOC 2, HIPAA and GDPR on every plan ([pricing](https://supermemory.ai/pricing)).
- **Ingestion:** add documents or conversations with a `customId`; updates bill only new tokens. Namespaces use "container tags." Connectors: Gmail (Max plan); S3 and web crawler (Scale) ([pricing](https://supermemory.ai/pricing), [docs](https://supermemory.ai/docs)).
- **Query:** semantic search plus graph traversal in one call, at a claimed 187 ms median. Re-ranking, aggregation and query rewriting are billed as "operations." User profiles and filtering are available ([pricing](https://supermemory.ai/pricing), [docs](https://supermemory.ai/docs)).
- **Axes:**
  - Runtime: no.
  - Durable: no.
  - Threads: partial (stores conversation content as memory or docs).
  - Query: **yes**.
  - Prompts: no.
  - Tools: MCP server (MIT-licensed) ([pricing FAQ](https://supermemory.ai/pricing)).
  - BYOK: no. "Memory runs on our own model. No LLM key to bring" ([pricing](https://supermemory.ai/pricing)).
  - Isolation: free local binary (closed source, up to 10k docs); own-cloud or dedicated instance on Scale and Enterprise; air-gapped on Enterprise ([pricing FAQ](https://supermemory.ai/pricing)).
  - Console: `console.supermemory.ai`.
- **Pricing** ([pricing](https://supermemory.ai/pricing)):
  - Plans: Free $0 ($5 credits/mo), Pro $19 ($20), Max $100 ($130), Scale $399 ($600), Enterprise custom.
  - Rates: memory ingest $0.005 per 1K tokens (plain) or $0.010 (rich); SuperRAG $0.001 (text) or $0.002 (rich) per 1K; search $0.005 per 1K queries; operations $0.10 per 1K.
  - Unlimited end users on every plan.
  - Subscription credits reset monthly; top-up credits never expire.
- **Retention:** not published (unverified).
- **Supermemory does, Kerby doesn't:** per-user memory graph, multimodal RAG, connectors, a single search call.
- **Kerby differs:** BYOK only, verbatim transcripts, it runs the agent, and it has a database per tenant.

#### Letta (brief; stateful-agent runtime with memory)

- **What / status:** a hosted service for stateful agents, also used by individuals through Letta Code ([pricing docs](https://docs.letta.com/pricing)). This is the one memory-origin vendor that _runs the agent_. Appendix B covers it in more depth.
- **Axes:**
  - Runtime: **yes** (stateful agents on Letta Cloud).
  - Durable: unverified.
  - Threads: yes (agents persist memory; "memory repository" storage per plan).
  - Query: unverified.
  - Prompts: no versioned-prompt product found.
  - Tools: **yes**. Remote MCP tools run at the provider and carry no credit cost; server-side tools are billed at $0.00015/s of CPU.
  - BYOK: **yes** on all plans.
  - Isolation: Enterprise RBAC and SSO; self-host: unverified here.
  - Console: `chat.letta.com` ([pricing docs](https://docs.letta.com/pricing)).
- **Pricing:**
  - Free: 3 agents, 5 MiB memory per repository.
  - Pro: $20/mo for $20 credits, 20 agents, 50 MiB.
  - Teams Pro: $20/seat/mo.
  - Enterprise: custom ([pricing docs](https://docs.letta.com/pricing)).
- **Kerby differs:** it is multi-tenant B2B with a database per tenant; it has prompt versions and labels plus decision-model guardrails; and its turns are durable with exactly-once tool calls.

#### Nebuly (conversation analytics)

- **What / status:** "The ROI platform for AI agents." It analyzes employee and customer conversations with AI agents for adoption, unmet demand, frustration, churn and upsell signals, ROI by team, and an AI proficiency score per team. It strips PII before analysis and runs its own models ([nebuly.com, 2026-11-23](https://www.nebuly.com/)). Raised a $21M Series A (announced on the homepage, [nebuly.com](https://www.nebuly.com/)).
- **Ingestion:** plugs into existing agents (Copilot, Claude Enterprise, custom). "Nothing changes in the agents themselves" ([nebuly.com](https://www.nebuly.com/)).
- **Query:** task/intent mapping, signals and dashboards. This is analytics, not an API for retrieving transcripts.
- **Axes:**
  - Runtime: no.
  - Durable: no.
  - Threads: no (it consumes them).
  - Query: **yes** (analytics, clustering, signals).
  - Prompts: no.
  - Tools: no.
  - BYOK: n/a (own models).
  - Isolation: SaaS or self-hosted in AWS, Azure, GCP or on-prem; ISO 27001/42001, SOC 2 ([nebuly.com](https://www.nebuly.com/)).
  - Console: **yes**, aimed at business leaders.
- **Pricing:** demo or quote only. Startup tier: up to 20k interactions, 1 project. Enterprise tier: self-hosted ([nebuly.com/pricing](https://www.nebuly.com/pricing)). A secondary estimate puts it at ~$36k/yr ([beatable.co](https://beatable.co/company/nebuly.com), unverified).
- **Relevance to Kerby:** it shows the analytics layer over the conversations Kerby already stores. That is a possible upsell, or an export/integration target.

---

### B. Tools / MCP infrastructure (per-end-user auth)

#### Composio

- **What / status:** an agent integration platform with 1,800+ toolkits through an SDK or MCP, managed OAuth, triggers, a sandbox, and "Firewall" ([platform pricing](https://composio.dev/pricing/platform)). GA. It also has a separate seat-priced consumer/team product: Free, with Standard at $18/seat "coming soon" ([pricing](https://composio.dev/pricing)).
- **Per-user auth:**
  - Everything is keyed to a stable `userID` you choose. Each user connects accounts through a hosted Connect Link.
  - Composio stores credentials encrypted, refreshes them before expiry, and never exports tokens (API responses are redacted).
  - The `COMPOSIO_MANAGE_CONNECTIONS` meta-tool lets the agent itself return an auth link in chat.
  - Multiple accounts per toolkit.
  - Customer-managed keys via a keyring proxy in your cloud.
  - Sources: [auth docs](https://docs.composio.dev/docs/authentication), [multi-account](https://docs.composio.dev/docs/managing-multiple-connected-accounts).
- **Axes:**
  - Runtime: no. It executes tools, not the LLM loop, though it runs "Sandbox LLM tokens" for its own sandbox.
  - Durable: no.
  - Threads: no.
  - Query: no (tool-call logs and audit only).
  - Prompts: no.
  - Tools: **yes**. Catalog plus custom MCP servers; private per-end-user toolkits on Pro.
  - BYOK: n/a ("Your own model is never billed").
  - Isolation: zero data retention add-on; customer-managed KMS keys and BYOC on Enterprise ([platform pricing](https://composio.dev/pricing/platform), [pricing](https://composio.dev/pricing)).
  - Console: developer dashboard.
- **Pricing** ([platform pricing](https://composio.dev/pricing/platform)):
  - Hobby: $0, hard-capped. 100k tool calls/mo (20k on Composio-managed apps), 50k trigger events, 1M sandbox LLM tokens, unlimited connected accounts on your own OAuth app, 3 members.
  - Pro: $29/mo including $29 usage credit. Extra calls $0.0003; managed-app calls at per-app rates (e.g. $0.01 for Salesforce) for signups from 2026-11-03; managed-app connections $0.10 each after 1k; triggers $0.003 per event.
  - Pro add-ons: Firewall $0.50 per 1M tokens, ZDR +$0.0001 per call, BAA +$0.0003 per call.
  - Enterprise: SSO/SCIM, customer-managed keys, BAA.
- **Overlap with Kerby:** Firewall "uses decision models to check tool requests and results against your policies" ([platform pricing](https://composio.dev/pricing/platform)). That is directly analogous to Kerby's decision-model guardrails on tool calls.
- **Composio does, Kerby doesn't:** per-end-user OAuth vault, 1,800 prebuilt toolkits, triggers.
- **Kerby differs:** it runs the agent; tool auth is per tenant, not per end user.

#### Arcade.dev (now incl. Smithery)

- **What / status:** "The actions runtime for production AI agents" ([pricing](https://www.arcade.dev/pricing)), described as an MCP runtime handling user auth, authorization, policy and tool execution ([docs](https://docs.arcade.dev/en/get-started/about-arcade)).
  - Acquired Smithery on 2026-08-05 ([blog](https://www.arcade.dev/blog/smithery-joins-arcade/)).
  - Shipped Multi-Profile, several accounts per provider behind one gateway, on 2026-11-19 ([blog list on same page](https://www.arcade.dev/blog/smithery-joins-arcade/)).
  - A $60M Series A in June 2026 is reported only by secondary sources ([dealroom](https://app.dealroom.co/news/feed/arcade-acquires-smithery-to-control-mcp-registry-and-runtime-layer)).
- **Per-user auth:**
  - Tools declare `requires_auth`. Arcade runs the OAuth flow, injects the token into `context.authorization.token`, and remembers the grant until it expires or is revoked ([docs](https://docs.arcade.dev/home/build-tools/create-a-tool-with-auth)).
  - An MCP gateway federates several MCP servers behind one URL, authenticated with Arcade Auth, your own OIDC provider, or API-key headers ([developers](https://www.arcade.dev/developers/)).
- **Axes:**
  - Runtime: no (tool runtime only).
  - Durable: no.
  - Threads: no.
  - Query: no.
  - Prompts: no.
  - Tools: **yes** (hosted MCP servers, gateway, tool catalog, ToolBench).
  - BYOK: n/a.
  - Isolation: Enterprise on Arcade Cloud, in your VPC, or air-gapped; SSO, RBAC, audit logs, private registry ([pricing](https://www.arcade.dev/pricing)).
  - Console: developer dashboard.
- **Pricing** ([pricing](https://www.arcade.dev/pricing)):
  - Free: 2,000 tool calls/mo.
  - Team: $25/mo plus $0.01 per tool call.
  - Enterprise: annual bundles.
  - No per-seat pricing.
  - Older secondary figures for $0.10 auth events and $0.05/hr hosted MCP don't appear on the current page (unverified/stale).

#### Smithery

- **Status:** acquired by Arcade on 2026-08-05 ([Arcade blog](https://www.arcade.dev/blog/smithery-joins-arcade/)).
  - Shut down on 2026-10-31: MCP Proxy, managed identity, API, Connect, Toolbox, accounts, API keys, and the run.tools / server.smithery.ai URLs. The CLI and SDKs are deprecated.
  - Charges since 2026-08-05 were refunded ([smithery.ai/future](https://smithery.ai/future)).
  - Smithery remains only as a free public MCP directory "now powered by Arcade.dev," linking to vendors' official MCP URLs ([smithery.ai](https://smithery.ai/)).
- **Relevance:** not a competitor any more. It is a discovery surface that funnels users to Arcade. A Kerby tenant looking for MCP URLs to register might find them there.

#### Klavis AI (Strata)

- **Status:** pivoted. The homepage now sells "RL environments and high-quality training data" for AI labs ([klavis.ai](https://www.klavis.ai/)). The MCP integrations repo is marked "[DEPRECATED] Legacy Klavis AI MCP integrations." The notice says the hosted MCP Platform is _not_ shut down, and existing customers can still reach it ([GitHub](https://github.com/Klavis-AI/klavis)).
- **Former model:** Strata, one MCP server that progressively discloses thousands of tools, and per-`user_id` MCP server instances with OAuth ([GitHub README](https://github.com/Klavis-AI/klavis)). Secondary sources date the repo archive to 2026-11-05 ([anythingmcp.com](https://anythingmcp.com/vs/klavis-ai)).
- **Relevance:** exit. Not a competitor.

#### Pipedream Connect (Workday)

- **What / status:** "The integration layer for AI agents": managed auth and 10,000+ tools across 3,000+ APIs; remote MCP server; Connect proxy; triggers ([pipedream.com](https://pipedream.com/)). Workday closed the acquisition, reported with its FY26 Q4 results on 2026-02-24 ([Workday newsroom](https://newsroom.workday.com/2026-02-24-Workday-Announces-Fiscal-2026-Fourth-Quarter-and-Full-Year-Financial-Results)). Also offers "Conduit," an employee MCP gateway with SSO, policies and audit, in early access ([pipedream.com](https://pipedream.com/)).
- **Per-user auth:** the remote MCP URL takes an `x-pd-external-user-id` header. Users authorize through a hosted Connect Link or an embedded SDK flow. Pipedream stores and refreshes tokens and injects fresh tokens per request. Bring-your-own OAuth clients are supported ([pipedream.com](https://pipedream.com/)).
- **Axes:**
  - Runtime: no.
  - Durable: no.
  - Threads: no.
  - Query: no.
  - Prompts: no.
  - Tools: **yes**.
  - BYOK: n/a.
  - Isolation: SOC 2 Type 2 and GDPR; HIPAA, SSO and static egress IPs on Business ([pricing](https://pipedream.com/pricing)).
  - Console: yes (workflow builder heritage).
- **Pricing** ([pricing](https://pipedream.com/pricing)):
  - Free: development only.
  - Startup: $99/mo annual or $150 monthly. 100 external users, then $2 per user; 10k credits, then $0.012 each. 1 credit = 30 s of compute per action, tool call, proxy request or trigger event.
  - Business: custom.

#### Nango

- **What / status:** auth and integrations infrastructure for "1,400+ APIs & MCPs," with 10k+ prebuilt tools, triggers and syncs. Open source; self-host/BYOC on Enterprise ([pricing](https://nango.dev/pricing)).
- **Per-user auth:** a connection is one authorized user account; there are embeddable auth UI components; white-label branding is available ([pricing](https://nango.dev/pricing)).
- **Pricing** ([pricing](https://nango.dev/pricing)):
  - Free: 10 connections, 10 compute-hours, 10 GB.
  - Pay-as-you-go: $50/mo with $50 credits. $0.29 per connection/mo, $0.72 per compute-hour, $0.50/GB.
  - Enterprise: from $0.01 per connection at scale.
  - No EU cloud; BYOC in any region.
- **Axes:** tools **yes**; isolation via BYOC/self-host; everything else no.

#### Merge Agent Handler

- **What / status:** "Production-ready MCP connectors for AI agents." Managed connectors, a guided auth flow, tool packs scoped per agent / customer tier / environment, security rules, and logs ([product](https://www.merge.dev/merge-agent-handler)). Customers listed include OpenAI, Perplexity, Ramp and JetBrains (same page).
- **Per-user auth:** the server attaches the right user's credentials per call and checks each call against rules ([how it works](https://docs.merge.dev/merge-agent-handler/how-it-works)). An employee mode uses SSO with role-based tool access ([docs](https://docs.merge.dev/merge-agent-handler/setup/agent-handler-for-employees)).
- **Pricing** ([pricing](https://www.merge.dev/pricing/agent-handler)):
  - Free: 2,000 credits/mo, unlimited registered users.
  - Pro: $1,000/mo for 25,000 credits.
  - Enterprise: on-prem, SIEM streaming.
- **Axes:** tools **yes**; guardrail rules (partial overlap with Kerby's decision models); isolation via on-prem on Enterprise; no runtime or history.

#### Other MCP gateways (identity- and API-gateway-first; not verified individually)

- A secondary roundup groups the 2026 gateway market into four camps ([SecureAuth](https://secureauth.com/learn/agentic-ai-security/best-mcp-gateways-2026)):
  - Identity-first: Okta Agent Gateway, Aembit, Pomerium, Runlayer, Cloudflare MCP server portals.
  - API gateways with MCP added: Kong, Azure APIM, agentgateway.
  - Open source: Docker MCP Gateway, IBM ContextForge, Microsoft MCP Gateway, Obot.
  - Managed: TrueFoundry, Portkey, MintMCP.
- The same secondary source says Docker MCP Gateway has no multi-user OAuth on-behalf-of support ([digitalapi.ai](https://www.digitalapi.ai/blogs/best-mcp-gateways-2026), unverified).
- These sit on the enterprise-IT side and govern employees' agents. They are not a substitute for Kerby.

---

### C. Sandboxed execution (moving up-stack?)

#### E2B

- **Status / direction:**
  - The 2026-10-16 post "Sandboxes are dead" says agents need "a full operating environment… That isn't a sandbox anymore. It's a platform," calls the new direction an "agent-driven private cloud," and claims E2B has run "billions of agents" ([e2b.dev](https://e2b.dev/resources/sandboxes-are-dead)).
  - Recent launches per E2B's blog index: Embed (2026-09-30), Secrets, Workload Identity ([product blog](https://e2b.dev/blog/category/product)).
  - Press release reports $120M ARR ([BusinessWire via financialcontent](https://www.financialcontent.com/article/bizwire-2026-11-5-e2b-which-gives-ai-agents-their-own-cloud-computers-passes-120-million-in-annual-recurring-revenue-with-100-inbound)).
- **Pricing** ([pricing](https://e2b.dev/pricing)):
  - Hobby: $0 with a one-time $100 credit, 10 concurrent sandboxes, 1 h sessions.
  - Pro: $150/mo, 100 concurrent sandboxes, 24 h sessions.
  - Enterprise: $3k/mo minimum, BYOC.
  - Rates: $0.000014 per vCPU-second, $0.0000045 per GiB-second.
- **Agent-runtime overlap:** not today. No LLM loop, conversation store or prompts. The stated direction (agents' "traces," recommending tools and services) points up-stack. Watch it.

#### Daytona

- **Status / direction:** "More Than a Sandbox. The Runtime AI Agents Actually Need." Sandboxes "run indefinitely — built for long-running tasks and persistent agents"; snapshots let you "save, restore, and resume any agent workflow"; Secrets are substituted at egress; compute can be customer-managed in your cloud ([daytona.io](https://www.daytona.io/)). Raised a $60M Series B at a $1B valuation in October 2026 as an "agent cloud" (press: [TechCrunch](https://techcrunch.com/2026/10/23/agent-cloud-startup-daytona-hits-1b-valuation-backed-by-firstmark-and-a-whos-who-of-angels/)).
- **Pricing:** $0.0504 per vCPU-hour, $0.0162 per GiB-hour of memory, GPUs from $0.57/h (RTX 4090) to $5.17/h (B300), $200 free compute ([daytona.io](https://www.daytona.io/)).
- **Agent-runtime overlap:** partial on durability. Daytona resumes environment state, but it doesn't resume LLM turns, run the loop or store conversations. The egress secret substitution parallels Kerby's egress guard.

#### Modal

- **Status / direction:** VM Sandboxes went GA on 2026-10-01 as "full computers for agents"; Linear's Coding Sessions run on them ([blog](https://modal.com/blog/vm-sandboxes-agent-computers)). Modal also sells hosted open-weight Model APIs, e.g. Kimi K3.1 Pro at $2/$10 per 1M tokens ([pricing](https://modal.com/pricing)).
- **Pricing:** sandboxes are billed at the non-preemptible rate, 3× list: $0.00003942 per core-second and $0.00000667 per GiB-second. Starter: $0 with $30/mo credits. Team: $250/mo with $100 credits ([pricing](https://modal.com/pricing)).
- **Agent-runtime overlap:** no. Modal is general serverless compute plus model inference. It could host a customer's own agent loop, which competes with Kerby only as the "build it yourself" option.

---

### D. Business-facing agent platforms (one line each: competitor to an API-first runtime?)

- **Dust:** a hosted agent workspace for teams. Custom agents, 20+ models, MCP (5 remote on Business), connectors, US/EU residency, single-tenant deployment on Enterprise. Business seats: Free, Pro €24 (8k credits), Max €120 (40k credits). The developer "Conversation API" bills programmatic use at $0.01/credit ([pricing](https://dust.tt/home/pricing), [dev docs](https://docs.dust.tt/docs/developer-platform/overview/developer-platform)). **Partial competitor:** closest in shape (hosted loop, conversations API, MCP, residency), but it is seat-priced for internal employees, models are bundled (no BYOK), and it is not built for an app with its own end users.
- **Relevance AI:** an "AI workforce" platform, Enterprise-only, sales-led. Unlimited agents, tools and workforces; 2,000+ integrations; evals and A/B testing; SSO/RBAC ([pricing](https://relevanceai.com/pricing)). **Not a competitor:** no-code business automation sold to ops and GTM teams.
- **Voiceflow:** an agent builder for CX teams and agencies. Voice and chat channels, environments (dev → staging → prod), observability, "bring your own model"; usage-based; business pricing on request ([pricing](https://www.voiceflow.com/pricing)). **Weak competitor:** it hosts agents and conversations with environments, but its value is the visual builder and channels, not an API runtime.
- **Botpress:** priced per conversation with LLM spend bundled. Free: 100 conversations. Plus: $150/mo for 250 conversations, then $0.65 each. Team: $750/mo for 1,500 conversations. $0.10 of AI usage is included per conversation ([pricing](https://botpress.com/pricing)). **Weak competitor:** it hosts the bot and its transcripts for SMB support, but there's no BYOK-only API, and models are resold.
- **Stack AI:** a no-code enterprise agent and workflow builder. Free: 500 runs/mo. Enterprise: on-prem/VPC, SSO, HIPAA ([pricing](https://www.stackai.com/pricing)). **Not a competitor:** document-processing workflows for finance, healthcare and industrials; REST API exposure is secondary.
- **Sierra:** a conversational AI platform for enterprise CX. Ghostwriter builds agents; Explorer runs deep research over conversations; monitors, experiments, observability, customer-context memory; outcome-based pricing ([sierra.ai](https://sierra.ai/)). **Not a direct competitor:** a vertical, sales-led, outcome-priced product. It does show the history analytics enterprises expect ("Deep Research for conversations").
- **Decagon:** an AI concierge for CX across chat, voice and email. Agents are defined in natural-language "Agent Operating Procedures," with testing and experimentation, cross-channel memory and analytics ([decagon.ai](https://decagon.ai/)). Pricing not published. **Not a direct competitor:** the same reasoning as Sierra.
