import { type KerbyOptions, Transport } from "./http.ts";
import { Conversations } from "./resources/conversations.ts";
import { Events } from "./resources/events.ts";
import { Integrations } from "./resources/integrations.ts";
import { Judgments } from "./resources/judgments.ts";
import { ModelKeys } from "./resources/model-keys.ts";
import { Prompts } from "./resources/prompts.ts";
import { Search } from "./resources/search.ts";
import { Subscriptions } from "./resources/subscriptions.ts";
import { ToolServers } from "./resources/tool-servers.ts";
import { Tools } from "./resources/tools.ts";

/**
 * A client for one Kerby integration's API key.
 *
 * ```ts
 * const kerby = new Kerby({ apiKey, baseUrl });
 * const chat = await kerby.conversations.create({ system: "You are terse." });
 * const { text } = await kerby.conversations.ask(chat.id, "Hello");
 * ```
 *
 * What a key may call depends on its integration's scopes (`conversations`, `judgments`, `events`, `tenant`,
 * `admin`); a call outside them throws `KerbyApiError` with status 403 and code `forbidden`.
 */
export class Kerby {
  /** Chats: create, post, read, wait for the answer, stream, trace. Scope `conversations`. */
  readonly conversations: Conversations;
  /** Typed yes/no, choice and score questions about some state. Scope `judgments`. */
  readonly judgments: Judgments;
  /** The event log: poll or long-poll what happened. Scope `events`. */
  readonly events: Events;
  /** Search the chats you may see; search settings need `admin`. */
  readonly search: Search;
  /** Tools your integration may name when it creates a conversation. Scope `conversations`. */
  readonly tools: Tools;
  /** Named, versioned chat and decision prompts. Scope `admin`. */
  readonly prompts: Prompts;
  /** Webhook subscriptions to the event log. Scope `admin`. */
  readonly subscriptions: Subscriptions;
  /** Remote MCP tool servers and their tools. Scope `admin`. */
  readonly toolServers: ToolServers;
  /** The workspace's integrations and which tools each may use. Scope `admin`. */
  readonly integrations: Integrations;
  /** The workspace's own model-provider keys. Scope `admin`. */
  readonly modelKeys: ModelKeys;

  constructor(options: KerbyOptions) {
    const http = new Transport(options);
    this.conversations = new Conversations(http);
    this.judgments = new Judgments(http);
    this.events = new Events(http);
    this.search = new Search(http);
    this.tools = new Tools(http);
    this.prompts = new Prompts(http);
    this.subscriptions = new Subscriptions(http);
    this.toolServers = new ToolServers(http);
    this.integrations = new Integrations(http);
    this.modelKeys = new ModelKeys(http);
  }
}
