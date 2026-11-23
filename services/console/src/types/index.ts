import type { Limits } from "@kerby/contracts";
import type { ControlDb } from "@kerby/db";
import type { Sealer } from "@kerby/secrets";

/** Control's sign-up route (`POST /v1/console/signups`), the console's only call to another service. */
export type SignupClient = (request: {
  name: string;
  email: string;
  passwordHash: string;
}) => Promise<
  | { ok: true; tenantId: string; userId: string; secret: string }
  | { ok: false; code: "name_taken" | "email_taken" }
>;

/** Everything the service layer needs, built once in `src/index.ts`. */
export type ConsoleDeps = {
  /** As the `kerby_console` role: tenants, keys, model keys, people and sessions; never a key hash. */
  control: ControlDb;
  /** Seals model keys to the platform public key; it cannot open them (ADR 0008). */
  sealer: Sealer;
  signups: SignupClient;
  settings: {
    /** Providers a tenant may store a key for: the harness adapter's list, injected by the composition root. */
    modelProviders: readonly string[];
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

export type ProviderView = {
  /** As a model id spells it: `anthropic` in `anthropic/<model>`. */
  id: string;
  configured: boolean;
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
};
