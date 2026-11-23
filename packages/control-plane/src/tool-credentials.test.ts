import { createOpener, createSealer, generateSecretsKeyPair, SecretsError } from "@kerby/secrets";
import { describe, expect, it } from "vitest";
import {
  deleteToolCredential,
  hasToolCredential,
  insertTenant,
  MAX_MODEL_KEYS_PER_TENANT,
  putModelKey,
  putToolCredential,
  readToolCredential,
} from "./index.ts";
import { createTestControlDb } from "./testing.ts";

const newTenant = (name: string) => ({ name, dbHost: "db.local", dbPort: 5432 });

describe("tool credentials", () => {
  it("seals, replaces, opens and deletes a server's credential", async () => {
    await using control = await createTestControlDb();
    const pair = generateSecretsKeyPair();
    const sealer = createSealer(pair.publicKey);
    const opener = createOpener([pair.privateKey]);
    const tenant = await insertTenant(control.db, newTenant("a"));
    const server = crypto.randomUUID();

    expect(await hasToolCredential(control.db, tenant.id, server)).toBe(false);
    await putToolCredential(control.db, sealer, tenant.id, server, "Bearer one");
    await putToolCredential(control.db, sealer, tenant.id, server, "Bearer two");
    expect(await hasToolCredential(control.db, tenant.id, server)).toBe(true);
    expect(await readToolCredential(control.db, opener, tenant.id, server)).toBe("Bearer two");
    expect(
      await readToolCredential(control.db, opener, tenant.id, crypto.randomUUID()),
    ).toBeUndefined();
    const { rows } = await control.db.query<{ name: string; ciphertext: Buffer }>(
      "select name, ciphertext from tenant_secrets where tenant_id = $1",
      [tenant.id],
    );
    expect(rows.map((row) => row.name)).toEqual([`tool-credential/${server}`]);
    expect(rows[0]?.ciphertext.includes(Buffer.from("Bearer two"))).toBe(false);

    expect(await deleteToolCredential(control.db, tenant.id, server)).toBe(true);
    expect(await deleteToolCredential(control.db, tenant.id, server)).toBe(false);
    expect(await readToolCredential(control.db, opener, tenant.id, server)).toBeUndefined();
    await expect(putToolCredential(control.db, sealer, tenant.id, "github", "x")).rejects.toThrow(
      /not a tool server id/,
    );
  });

  it("does not open under another tenant's or another server's name", async () => {
    await using control = await createTestControlDb();
    const pair = generateSecretsKeyPair();
    const sealer = createSealer(pair.publicKey);
    const opener = createOpener([pair.privateKey]);
    const a = await insertTenant(control.db, newTenant("a"));
    const b = await insertTenant(control.db, newTenant("b"));
    const server = crypto.randomUUID();
    const remade = crypto.randomUUID();
    await putToolCredential(control.db, sealer, a.id, server, "Bearer a");
    await putToolCredential(control.db, sealer, b.id, server, "Bearer b");
    await putToolCredential(control.db, sealer, a.id, remade, "Bearer new");

    const copy = (fromTenant: string, fromServer: string, toTenant: string, toServer: string) =>
      control.db.query(
        `update tenant_secrets set ciphertext = (select ciphertext from tenant_secrets where tenant_id = $1 and name = $2)
          where tenant_id = $3 and name = $4`,
        [fromTenant, `tool-credential/${fromServer}`, toTenant, `tool-credential/${toServer}`],
      );
    // another tenant's row under the same server id
    await copy(a.id, server, b.id, server);
    await expect(readToolCredential(control.db, opener, b.id, server)).rejects.toBeInstanceOf(
      SecretsError,
    );
    // a deleted server's credential moved onto a new server of the same tenant
    await copy(a.id, server, a.id, remade);
    await expect(readToolCredential(control.db, opener, a.id, remade)).rejects.toBeInstanceOf(
      SecretsError,
    );
    expect(await readToolCredential(control.db, opener, a.id, server)).toBe("Bearer a");
  });

  it("does not count against the model-key limit", async () => {
    await using control = await createTestControlDb();
    const sealer = createSealer(generateSecretsKeyPair().publicKey);
    const tenant = await insertTenant(control.db, newTenant("a"));
    await putToolCredential(control.db, sealer, tenant.id, crypto.randomUUID(), "Bearer t");
    await putToolCredential(control.db, sealer, tenant.id, crypto.randomUUID(), "Bearer u");
    for (let i = 0; i < MAX_MODEL_KEYS_PER_TENANT; i++) {
      await putModelKey(control.db, sealer, tenant.id, `p${i}`, "k");
    }
    // and a tenant at the model-key limit can still store a credential
    await putToolCredential(control.db, sealer, tenant.id, crypto.randomUUID(), "Bearer v");
  });
});
