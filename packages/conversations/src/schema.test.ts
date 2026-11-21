import { expect, it } from "vitest";
import { createTestTenant } from "./testing.ts";

it("a test tenant has Absurd, the blob index and the conversation tables", async () => {
  await using tenant = await createTestTenant();
  const { rows } = await tenant.db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema in ('public', 'absurd') and table_name in ('blobs', 'conversations', 'messages', 't_turns', 't_system')",
  );
  expect(rows.map((r) => r.table_name).sort()).toEqual([
    "blobs",
    "conversations",
    "messages",
    "t_system",
    "t_turns",
  ]);
});

it("refuses a second message with the same seq in a conversation", async () => {
  await using tenant = await createTestTenant();
  const blob = await tenant.db.query<{ id: string }>(
    "insert into blobs (object_key, kind, media_type, size, sha256) values ('k', 'message', 'application/json', 1, 'x') returning id",
  );
  const conversation = await tenant.db.query<{ id: string }>(
    "insert into conversations (model) values ('m') returning id",
  );
  const insert = () =>
    tenant.db.query(
      "insert into messages (conversation_id, seq, role, blob_id) values ($1, 1, 'user', $2)",
      [conversation.rows[0]?.id, blob.rows[0]?.id],
    );
  await insert();
  await expect(insert()).rejects.toThrow(/duplicate key/);
});
