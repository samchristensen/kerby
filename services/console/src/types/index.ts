import type {
  ConversationSummary,
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
  apiKeys(session: Session): Promise<ApiKeyView[]>;
  /** `secret` is the whole key, shown once and never stored. */
  createApiKey(
    session: Session,
    form: FormInput,
  ): Promise<{ ok: true; key: ApiKeyView; secret: string } | FormFailure>;
  /** False when the tenant has no such live key. */
  revokeApiKey(session: Session, keyId: string): Promise<boolean>;
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
