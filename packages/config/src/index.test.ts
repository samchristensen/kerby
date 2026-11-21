import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigError, envName, loadConfig } from "./index.ts";

const schema = z.object({
  databaseUrl: z.string().min(1),
  port: z.coerce.number().int().default(8080),
  apiToken: z.string().min(8),
});

const dirs: string[] = [];
function scratch(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "kerby-config-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("maps camelCase keys to SCREAMING_SNAKE names", () => {
    expect(envName("databaseUrl")).toBe("DATABASE_URL");
    expect(envName("s3Endpoint")).toBe("S3_ENDPOINT");
  });

  it("layers file < env < secrets, and coerces strings", () => {
    const dir = scratch({
      "config.yaml": "databaseUrl: from-file\nport: 1111\napiToken: file-token\n",
      "secrets/API_TOKEN": "secret-token\n",
    });
    const config = loadConfig(schema, {
      file: join(dir, "config.yaml"),
      secretsDir: join(dir, "secrets"),
      env: { DATABASE_URL: "from-env", PORT: "2222", API_TOKEN: "env-token" },
    });
    expect(config).toEqual({ databaseUrl: "from-env", port: 2222, apiToken: "secret-token" });
  });

  it("applies schema defaults", () => {
    const config = loadConfig(schema, {
      env: { DATABASE_URL: "x", API_TOKEN: "long-enough" },
      secretsDir: scratch(),
    });
    expect(config.port).toBe(8080);
  });

  it("names every bad key and none of the values", () => {
    const secret = "short";
    let error: unknown;
    try {
      loadConfig(schema, {
        env: { API_TOKEN: secret, PORT: "not-a-number" },
        secretsDir: scratch(),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as ConfigError).message;
    for (const key of ["databaseUrl", "port", "apiToken"]) expect(message).toContain(key);
    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("not-a-number");
  });

  it("rejects a file key the schema does not know", () => {
    const dir = scratch({ "config.yaml": "databaseUrl: x\ndatabseUrl: typo\n" });
    expect(() =>
      loadConfig(schema, { file: join(dir, "config.yaml"), env: {}, secretsDir: dir }),
    ).toThrow(/unknown keys: databseUrl/);
  });

  it("fails when a named file or secrets directory is missing", () => {
    expect(() => loadConfig(schema, { file: "/nonexistent/kerby.yaml", env: {} })).toThrow(
      /does not exist/,
    );
    expect(() => loadConfig(schema, { secretsDir: "/nonexistent/secrets", env: {} })).toThrow(
      /does not exist/,
    );
  });

  it("reads KERBY_CONFIG_FILE and KERBY_SECRETS_DIR from the environment", () => {
    const dir = scratch({
      "c.yaml": "databaseUrl: from-file\n",
      "s/API_TOKEN": "secret-token",
    });
    const config = loadConfig(schema, {
      env: { KERBY_CONFIG_FILE: join(dir, "c.yaml"), KERBY_SECRETS_DIR: join(dir, "s") },
    });
    expect(config).toMatchObject({ databaseUrl: "from-file", apiToken: "secret-token" });
  });
});
