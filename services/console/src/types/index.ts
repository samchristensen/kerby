import type {
  ConversationSummary,
  DeliveryAttempt,
  GetConversationResponse,
  Judgment,
  Limits,
  PinnedPrompt,
  PostMessageResponse,
  Prompt,
  PromptKind,
  PromptSummary,
  PromptVariable,
  PromptVersion,
  PromptVersionSummary,
  Scope,
  Subscription,
} from "@kerby/contracts";
import type { ControlDb } from "@kerby/db";
import type { Sealer } from "@kerby/secrets";

/** Control's sign-up route (`POST /v1/console/signups`), the console's only call to another service. */
export type SignupClient = (request: {
  name: string;
  email: string;
  passwordHash: string;
}) => Promise<
  | { ok: true; tenantId: string; userId: string; secret: string }
  | { ok: false; code: "name_taken" | "email_taken" | "not_invited" }
>;

/**
 * The tenant API on the private network: the console's second call to another service. `token` is the signed-in
 * person's session token, sent as the bearer credential; the api verifies it and takes the tenant from it, so a chat
 * can only ever reach the tenant the person belongs to. Resolves with the api's response, whatever its status.
 */
export type ApiClient = (request: {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  token: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** A long-lived event stream: no timeout, only `signal` ends it. */
  stream?: true;
  signal?: AbortSignal;
}) => Promise<Response>;

/** Everything the service layer needs, built once in `src/index.ts`. */
export type ConsoleDeps = {
  /** As the `kerby_console` role: tenants, keys, model keys, people and sessions; never a key hash. */
  control: ControlDb;
  /** Seals model keys to the platform public key; it cannot open them (ADR 0008). */
  sealer: Sealer;
  signups: SignupClient;
  api: ApiClient;
  settings: {
    /** Providers whose models run chats: the harness adapter's list, injected by the composition root. */
    modelProviders: readonly string[];
    /** Providers that run judgments (ADR 0015): a tenant stores a key for these too, but cannot chat with them. */
    judgmentProviders: readonly string[];
    /** The tenant API's public address, shown in the quickstart. */
    apiPublicUrl: string;
    sessionTtlMs: number;
    /** log2 of scrypt's N for new password hashes (`PASSWORD_COST`); tests use a cheap one. */
    passwordCost: number;
    /** Sign-ups one client address may make per hour. */
    signupsPerHour: number;
    /** Failed sign-ins one client address may make per minute. */
    failedLoginsPerMinute: number;
    /** Failed sign-ins against one email per hour, from every address together. */
    failedLoginsPerAccountPerHour: number;
  };
};

// What the pages see. Plain data (strings, numbers, booleans), so it crosses into client components unchanged.

/** Who is signed in. Only `ConsoleService.session` makes one, from a verified session cookie. */
export type Session = {
  userId: string;
  email: string;
  tenantId: string;
  tenantName: string;
  /** The platform owner's flag (set by the operator, never by the console): may edit who can sign up. */
  isAdmin: boolean;
};

/** Form fields as the browser sent them (`Object.fromEntries(formData)`); the service parses them. */
export type FormInput = Record<string, unknown>;

/** A refused form: a message for the form, and per field where one field is wrong. */
export type FormFailure = { ok: false; error?: string; fields?: Record<string, string> };

export type SignedIn = { ok: true; token: string; expiresAt: string };

export type ApiKeyView = {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

/** An integration (ADR 0020): who its keys act for and what they may do. */
export type IntegrationView = {
  id: string;
  name: string;
  /** In catalog order (`SCOPES`). */
  scopes: Scope[];
  createdAt: string;
};

type IntegrationSummaryView = IntegrationView & {
  activeKeys: number;
  subscriptions: number;
};

/** With its keys, newest first, revoked ones included. */
type IntegrationDetailView = IntegrationView & { keys: ApiKeyView[] };

/** A page of a subscription's delivery log, newest first; `nextBefore` reads the older page. */
type DeliveryLogView = { deliveries: DeliveryAttempt[]; nextBefore: string | null };

/** A checkbox of a form: what it stands for and its field name. */
export type ScopeOption = { scope: Scope; description: string; field: string };
export type EventTypeOption = { pattern: string; field: string };
/** `*`, and per family (`turn`) its wildcard (`turn.*`) and its types. */
export type EventTypeOptions = {
  all: EventTypeOption;
  families: { family: string; wildcard: EventTypeOption; types: EventTypeOption[] }[];
};
/** One address on the sign-up allowlist. */
export type AllowedEmailView = { email: string; addedAt: string; signedUp: boolean };

export type ProviderView = {
  /** As a model id spells it: `anthropic` in `anthropic/<model>`. */
  id: string;
  configured: boolean;
  /** Its models run chats (a conversation's model id starts with `<id>/`). */
  chat: boolean;
  /** Its models run judgments and guardrails (`POST /v1/judgments`). A provider can be both: one key serves both. */
  decisions: boolean;
  /** When the key was last set. */
  updatedAt: string | null;
};

export type Overview = {
  tenantId: string;
  tenantName: string;
  status: string;
  plan: string;
  createdAt: string;
  /** Only the limits set for this tenant; an absent one is the plan default. */
  limits: Limits;
  activeApiKeys: number;
  modelKeys: number;
  apiUrl: string;
};

/**
 * Where a conversation began: a person in this console's chat, the Studio's playground, or the tenant's own code calling
 * the API.
 */
export type ChatOrigin = "console" | "studio" | "api";

export type ChatSummaryView = Pick<
  ConversationSummary,
  "id" | "title" | "model" | "messageCount" | "updatedAt" | "externalUserId"
> & { origin: ChatOrigin };

export type ChatListView = { chats: ChatSummaryView[]; nextCursor: string | null };

export type ChatStatus = { busy: boolean; lastError: string | null };

export type ChatView = ChatStatus & {
  id: string;
  title: string | null;
  model: string;
  system: string;
  externalUserId: string | null;
  origin: ChatOrigin;
  createdAt: string;
  updatedAt: string;
  /** The chat prompt version it was started from; null when it was given its own system prompt. */
  prompt: PinnedPrompt | null;
  /** Every message, oldest first. */
  messages: GetConversationResponse["messages"];
};

/**
 * The signed-in person and their session token, for the calls that go through the api. Server-side only, like the
 * cookie the token comes from: never a prop of a client component.
 */
export type ChatAccess = { session: Session; token: string };

/**
 * The console's operations, bound to their dependencies in `src/index.ts`. Next.js bundles `src/app`, so pages and
 * actions reach this through `consoleService()` (src/app/_lib/console.ts) and import its types only (ADR 0014). Every
 * method that touches tenant data takes the `Session` that `session` returned: the tenant id comes from nowhere else.
 */
export type ConsoleService = {
  /** Provision a tenant and its first person, then sign them in. `apiKey` is the tenant's first API key, shown once. */
  signUp(form: FormInput, client: string): Promise<(SignedIn & { apiKey: string }) | FormFailure>;
  logIn(form: FormInput, client: string): Promise<SignedIn | FormFailure>;
  logOut(token: string): Promise<void>;
  /** The session for a cookie's token; undefined when it is unknown, expired, or its tenant is not active. */
  session(token: string): Promise<Session | undefined>;
  /** The allowlist, oldest first. Admins only. */
  signupAllowlist(session: Session): Promise<AllowedEmailView[]>;
  /** Allow the emails in `form.emails` (separated by whitespace, commas or semicolons) to sign up. Admins only. */
  allowSignups(
    session: Session,
    form: FormInput,
  ): Promise<{ ok: true; added: number } | FormFailure>;
  /** Stop allowing `email`; an account it already made stays. False when it was not on the list. Admins only. */
  disallowSignup(session: Session, email: string): Promise<boolean>;
  overview(session: Session): Promise<Overview>;

  // Integrations (ADR 0020) and their keys, in the control database; audited as `user:<id>`. The pages cannot import
  // the scope or event type catalogs (ADR 0014), so the service hands them out with their form fields.
  /** Every scope with its description and the form field of its checkbox, in catalog order. */
  scopeOptions(): ScopeOption[];
  /** The tenant's live integrations, oldest first, with their live keys and subscriptions counted. */
  integrations(access: ChatAccess): Promise<IntegrationSummaryView[]>;
  /** A live integration with its keys; undefined when the tenant has none by that id. */
  integration(session: Session, id: string): Promise<IntegrationDetailView | undefined>;
  /** Form fields `name` and `scope.<scope>` (a checkbox per scope). */
  createIntegration(
    session: Session,
    form: FormInput,
  ): Promise<{ ok: true; id: string } | FormFailure>;
  /** Replace its scopes: form fields `scope.<scope>`. Its keys follow within the api's auth cache TTL. */
  setIntegrationScopes(
    session: Session,
    id: string,
    form: FormInput,
  ): Promise<{ ok: true } | FormFailure>;
  /** Revoke its keys and delete its subscriptions. False when the tenant has no such live integration. */
  deleteIntegration(session: Session, id: string): Promise<boolean>;
  /** A key of the integration (form field `label`). `secret` is the whole key, shown once and never stored. */
  createApiKey(
    session: Session,
    integrationId: string,
    form: FormInput,
  ): Promise<{ ok: true; key: ApiKeyView; secret: string } | FormFailure>;
  /** False when the tenant has no such live key. */
  revokeApiKey(session: Session, keyId: string): Promise<boolean>;

  // Event subscriptions (ADR 0019), through the api's `/v1/subscriptions` with the person's session token.
  eventTypeOptions(): EventTypeOptions;
  /** The integration's subscriptions, oldest first. */
  subscriptions(access: ChatAccess, integrationId: string): Promise<Subscription[]>;
  /** Undefined when the tenant has none by that id. */
  subscription(access: ChatAccess, id: string): Promise<Subscription | undefined>;
  /**
   * A webhook subscription of the integration: form fields `url`, `description`, `scope` (`own` or `tenant`) and
   * `type.<pattern>` (a checkbox per type, per family wildcard such as `turn.*`, and `*`). `secret` is shown once.
   */
  createSubscription(
    access: ChatAccess,
    integrationId: string,
    form: FormInput,
  ): Promise<{ ok: true; subscription: Subscription; secret: string } | FormFailure>;
  /** Enabling a disabled subscription resumes it where it stopped. */
  setSubscriptionEnabled(
    access: ChatAccess,
    id: string,
    enabled: boolean,
  ): Promise<{ ok: true } | FormFailure>;
  deleteSubscription(access: ChatAccess, id: string): Promise<{ ok: true } | FormFailure>;
  /** A new signing secret, shown once; the old one keeps signing beside it until `previousExpiresAt`. */
  rotateSubscriptionSecret(
    access: ChatAccess,
    id: string,
  ): Promise<{ ok: true; secret: string; previousExpiresAt: string } | FormFailure>;
  /** Queue a `ping` to the destination; the delivery log shows how it went. */
  testSubscription(
    access: ChatAccess,
    id: string,
  ): Promise<{ ok: true; eventId: string } | FormFailure>;
  /** A page of its delivery log, newest first, older than `before` when given; undefined when there is no such subscription. */
  deliveries(access: ChatAccess, id: string, before?: string): Promise<DeliveryLogView | undefined>;

  /** Every supported provider, configured or not, in the adapter's order. */
  providers(session: Session): Promise<ProviderView[]>;
  setModelKey(
    session: Session,
    provider: string,
    form: FormInput,
  ): Promise<{ ok: true } | FormFailure>;
  /** False when the tenant had no key for it. */
  removeModelKey(session: Session, provider: string): Promise<boolean>;
  /** A page of the tenant's conversations, most recently active first: this console's and those made through the API. */
  chats(access: ChatAccess, cursor?: string): Promise<ChatListView>;
  /** The whole conversation, or undefined when the tenant has none by that id. */
  chat(access: ChatAccess, id: string): Promise<ChatView | undefined>;
  /** Whether a turn is still running and why the last one failed; undefined when there is no such conversation. */
  chatStatus(access: ChatAccess, id: string): Promise<ChatStatus | undefined>;
  /**
   * Start a conversation with its first message: from `model` and `system` (both optional: the api's defaults), or
   * from a published chat prompt (`promptName`, `promptVersion` a number or label, `var.<name>` for its variables).
   */
  createChat(access: ChatAccess, form: FormInput): Promise<{ ok: true; id: string } | FormFailure>;
  /** Post a message to a conversation; its answer arrives on `chatEvents`. */
  sendMessage(
    access: ChatAccess,
    id: string,
    form: FormInput,
  ): Promise<{ ok: true; seq: PostMessageResponse["seq"] } | FormFailure>;
  /**
   * The api's server-sent event stream for a conversation, as the api answers it (any status): messages after `after`,
   * then live events. Ends when `signal` aborts.
   */
  chatEvents(
    access: ChatAccess,
    id: string,
    after: string | null,
    signal: AbortSignal,
  ): Promise<Response>;

  // The Studio (ADR 0017): prompts and decision models, through the api with the person's session token.
  /** Every prompt of the tenant, by name; of one kind when `kind` is given. */
  prompts(access: ChatAccess, kind?: PromptKind): Promise<PromptSummary[]>;
  /** The prompt with its draft and versions, or undefined when there is none by that name. */
  prompt(access: ChatAccess, name: string): Promise<Prompt | undefined>;
  /** One published version by number or label (`3`, `production`, `latest`); undefined when there is none. */
  promptVersion(
    access: ChatAccess,
    name: string,
    version: string,
  ): Promise<PromptVersion | undefined>;
  /** The `{{variables}}` a chat prompt's text refers to, in order of first appearance. */
  templateVariables(text: string): string[];
  /** A new prompt with an empty draft: form fields `name`, `kind`. */
  createPrompt(
    access: ChatAccess,
    form: FormInput,
  ): Promise<{ ok: true; name: string } | FormFailure>;
  /** Rename a prompt that has never been published: form field `name`. */
  renamePrompt(
    access: ChatAccess,
    name: string,
    form: FormInput,
  ): Promise<{ ok: true; name: string } | FormFailure>;
  /** Delete a prompt that has never been published. */
  deletePrompt(access: ChatAccess, name: string): Promise<{ ok: true } | FormFailure>;
  /** Replace the draft, if it is still at `revision`. */
  saveDraft(
    access: ChatAccess,
    name: string,
    revision: number,
    draft: unknown,
  ): Promise<{ ok: true; prompt: Prompt } | StudioFailure>;
  /** Publish the draft at `revision` as the next version: form field `note` (optional). */
  publishPrompt(
    access: ChatAccess,
    name: string,
    revision: number,
    form: FormInput,
  ): Promise<{ ok: true; version: PromptVersionSummary } | StudioFailure>;
  /** Point a label at a version: form fields `label`, `version`. */
  setPromptLabel(
    access: ChatAccess,
    name: string,
    form: FormInput,
  ): Promise<{ ok: true } | FormFailure>;
  removePromptLabel(
    access: ChatAccess,
    name: string,
    label: string,
  ): Promise<{ ok: true } | FormFailure>;
  /** The variables of a chat prompt's draft (`source` `draft`) or of a version (a number or a label). */
  promptVariables(
    access: ChatAccess,
    name: string,
    source: string,
  ): Promise<{ ok: true; variables: PromptVariable[] } | FormFailure>;
  /**
   * The chat playground: a real conversation as `studio:<userId>`, from the draft (rendered here) or a version (by
   * reference). Form fields `source` (`draft`, a number or a label) and `var.<name>` for each variable.
   */
  startPlaygroundChat(
    access: ChatAccess,
    name: string,
    form: FormInput,
  ): Promise<{ ok: true; id: string } | FormFailure>;
  /** The decision playground: a judgment of `state` (JSON text) by the draft or a version. Form fields `source`, `state`. */
  runDecision(
    access: ChatAccess,
    name: string,
    form: FormInput,
  ): Promise<{ ok: true; id: string } | FormFailure>;
  /** A judgment as the api reports it; undefined when there is none by that id. */
  judgment(access: ChatAccess, id: string): Promise<Judgment | undefined>;
};

/** A refused Studio save or publish; `conflict` when the draft changed elsewhere since the editor loaded it. */
export type StudioFailure = FormFailure & { conflict?: true };
