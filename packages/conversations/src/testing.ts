import type { AgentMessage } from "@kerby/agent";
import type { Blobs } from "@kerby/blobs";
import { type ClosableTenantDb, createTenantDb, type TenantContext } from "@kerby/db";
import { createMigratedDatabase } from "@kerby/db/testing";
import { createTenantExecutor } from "@kerby/durable";
import { persistMessage, tenantMigrationDirs } from "./index.ts";

export type TestTenant = TenantContext & { db: ClosableTenantDb; url: string } & AsyncDisposable;

/** A tenant with its own fresh, fully migrated database and a unique id (so a unique object prefix). */
export async function createTestTenant(): Promise<TestTenant> {
  const database = await createMigratedDatabase(tenantMigrationDirs);
  const db = createTenantDb(database.url, { max: 5 });
  return {
    tenantId: crypto.randomUUID(),
    db,
    url: database.url,
    async [Symbol.asyncDispose]() {
      await db.close();
      await database.drop();
    },
  };
}

/**
 * Finish the conversation's pending turn the way a worker would: claim it, persist `messages` in order under its
 * run (fenced, announced), and let it complete. For tests of what reads the result.
 */
export async function completeTurnWith(
  tenant: TenantContext,
  blobs: Blobs,
  conversationId: string,
  messages: AgentMessage[],
  between?: (persistedSeq: number) => Promise<void>,
): Promise<void> {
  const executor = createTenantExecutor(
    tenant.db,
    {
      "run-turn": async (_params, run) => {
        for (const message of messages) {
          const { rows } = await tenant.db.query<{ next: number }>(
            "select coalesce(max(seq), 0) + 1 as next from messages where conversation_id = $1",
            [conversationId],
          );
          const seq = rows[0]?.next ?? 1;
          await persistMessage(tenant, blobs, { conversationId, seq, message, run });
          await between?.(seq);
        }
      },
    },
    { workerId: "test-worker" },
  );
  const [task] = await executor.claim(1);
  if (!task) throw new Error("no turn to claim");
  await executor.execute(task);
}
