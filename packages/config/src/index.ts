// Configuration, read once at startup and validated against a zod schema (ARCHITECTURE.md#configuration).
// Sources, lowest to highest precedence: a YAML file, environment variables, a secrets directory.
// A key `databaseUrl` is `databaseUrl` in the file and `DATABASE_URL` in the environment and as a file name
// in the secrets directory (one file per secret, as Docker and Kubernetes mount them).
// Errors name keys and never values: a secret that fails validation must not end up in a log.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { z } from "zod";

export type ConfigSources = {
  /** Defaults to the process environment, which only this package may read. */
  env?: Record<string, string | undefined>;
  /** YAML file path. Defaults to `KERBY_CONFIG_FILE`; with neither, there is no file layer. */
  file?: string;
  /** Directory of one-file-per-secret. Defaults to `KERBY_SECRETS_DIR`, else `/run/secrets` when it exists. */
  secretsDir?: string;
};

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** `databaseUrl` -> `DATABASE_URL`. */
export function envName(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

const DEFAULT_SECRETS_DIR = "/run/secrets";

function readFileLayer(path: string, keys: ReadonlySet<string>): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new ConfigError(
      `config file ${path} does not exist. Fix: create it or unset KERBY_CONFIG_FILE.`,
    );
  }
  let doc: unknown;
  try {
    doc = parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`config file ${path} is not valid YAML: ${(error as Error).message}`);
  }
  if (doc === null || doc === undefined) return {};
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new ConfigError(`config file ${path} must be a YAML mapping of key to value.`);
  }
  const unknown = Object.keys(doc).filter((key) => !keys.has(key));
  if (unknown.length > 0) {
    throw new ConfigError(
      `config file ${path} has unknown keys: ${unknown.join(", ")}. Fix: remove them or fix the spelling; known keys: ${[...keys].join(", ")}.`,
    );
  }
  return { ...doc };
}

/**
 * Load, merge and validate configuration. Throws `ConfigError` naming every bad key, never a value.
 * Values from the environment and secrets are strings: use `z.coerce` in the schema for numbers and booleans
 * (`z.stringbool()` for booleans).
 */
export function loadConfig<S extends z.ZodObject>(
  schema: S,
  sources: ConfigSources = {},
): z.output<S> {
  const env = sources.env ?? process.env;
  const keys = new Set(Object.keys(schema.shape));

  const filePath = sources.file ?? env.KERBY_CONFIG_FILE;
  const merged: Record<string, unknown> = filePath ? readFileLayer(filePath, keys) : {};

  for (const key of keys) {
    const value = env[envName(key)];
    if (value !== undefined) merged[key] = value;
  }

  const explicitSecrets = sources.secretsDir ?? env.KERBY_SECRETS_DIR;
  const secretsDir =
    explicitSecrets ?? (existsSync(DEFAULT_SECRETS_DIR) ? DEFAULT_SECRETS_DIR : undefined);
  if (secretsDir) {
    if (!existsSync(secretsDir)) {
      throw new ConfigError(
        `secrets directory ${secretsDir} does not exist. Fix: create it or unset KERBY_SECRETS_DIR.`,
      );
    }
    for (const key of keys) {
      const path = join(secretsDir, envName(key));
      if (existsSync(path)) merged[key] = readFileSync(path, "utf8").trim();
    }
  }

  const result = schema.safeParse(merged);
  if (result.success) return result.data;
  const lines = result.error.issues.map((issue) => {
    const key = issue.path.map(String).join(".") || "(root)";
    const top = String(issue.path[0] ?? "");
    const where = top
      ? ` (set ${envName(top)}, the file key ${top}, or a secret file ${envName(top)})`
      : "";
    return `  ${key}: ${issue.message}${where}`;
  });
  throw new ConfigError(`invalid configuration:\n${lines.join("\n")}`);
}
