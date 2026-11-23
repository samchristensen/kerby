import { blobsMigrationsDir } from "@kerby/blobs";
import { MAX_PROMPT_VERSIONS, MAX_PROMPTS, type PromptBody } from "@kerby/contracts";
import { type ClosableTenantDb, createTenantDb } from "@kerby/db";
import { createMigratedDatabase } from "@kerby/db/testing";
import { describe, expect, it } from "vitest";
import {
  createPrompt,
  DraftConflictError,
  deletePrompt,
  getPrompt,
  getPromptVersion,
  listPrompts,
  NotPublishableError,
  PromptKindError,
  PromptLimitError,
  PromptNameTakenError,
  PromptNotFoundError,
  PromptPublishedError,
  PromptUnchangedError,
  promptsMigrationsDir,
  publishPrompt,
  ReservedLabelError,
  removePromptLabel,
  renamePrompt,
  StorageQuotaExceededError,
  saveDraft,
  setPromptLabel,
  storedBytes,
} from "./index.ts";

/** A tenant database with the blob index (the quota counts it) and the prompt tables. */
async function tenantDb(): Promise<ClosableTenantDb & AsyncDisposable> {
  const database = await createMigratedDatabase([blobsMigrationsDir, promptsMigrationsDir]);
  const db = createTenantDb(database.url, { max: 3 });
  return Object.assign(db, {
    async [Symbol.asyncDispose]() {
      await db.close();
      await database.drop();
    },
  });
}

const QUOTA = { storageBytes: 1024 ** 3 };
const ACTOR = "key:k1";

const chat = (text: string, variables: string[] = []): PromptBody => ({
  kind: "chat",
  text,
  guardrails: [],
  tools: [],
  variables: variables.map((name) => ({ name })),
});

/** Save `body` over the current draft and publish it; the new version's number. */
async function publish(db: ClosableTenantDb, name: string, body: PromptBody): Promise<number> {
  const current = await getPrompt(db, name);
  const revision = current?.prompt.draftRevision ?? 0;
  const saved = await saveDraft(db, name, { revision, draft: body, actor: ACTOR }, QUOTA);
  const { version } = await publishPrompt(
    db,
    name,
    { revision: saved.prompt.draftRevision, actor: ACTOR },
    QUOTA,
  );
  return version.version;
}

describe("prompts", () => {
  it("creates a prompt with an empty draft and lists prompts by name, of one kind or both", async () => {
    await using db = await tenantDb();
    const created = await createPrompt(
      db,
      { name: "support/triage", kind: "chat", actor: ACTOR },
      QUOTA,
    );
    expect(created.prompt).toMatchObject({
      name: "support/triage",
      kind: "chat",
      latestVersion: null,
      labels: {},
      draft: { kind: "chat", text: "", guardrails: [], variables: [] },
      draftRevision: 0,
      draftUpdatedBy: ACTOR,
      versions: [],
    });
    await createPrompt(db, { name: "billing", kind: "decision", actor: ACTOR }, QUOTA);
    expect((await listPrompts(db)).map((p) => p.name)).toEqual(["billing", "support/triage"]);
    expect((await listPrompts(db, { kind: "decision" })).map((p) => p.name)).toEqual(["billing"]);
    await expect(
      createPrompt(db, { name: "billing", kind: "chat", actor: ACTOR }, QUOTA),
    ).rejects.toBeInstanceOf(PromptNameTakenError);
    await expect(
      createPrompt(db, { name: "x", kind: "decision", draft: chat("hi"), actor: ACTOR }, QUOTA),
    ).rejects.toBeInstanceOf(PromptKindError);
  });

  it("saves a draft only at the revision it started from, and only of the prompt's kind", async () => {
    await using db = await tenantDb();
    await createPrompt(db, { name: "p", kind: "chat", actor: ACTOR }, QUOTA);
    const first = await saveDraft(
      db,
      "p",
      { revision: 0, draft: chat("one"), actor: "user:a" },
      QUOTA,
    );
    expect(first.prompt).toMatchObject({ draftRevision: 1, draftUpdatedBy: "user:a" });
    // A second editor who loaded revision 0 does not overwrite the first one's save unseen.
    await expect(
      saveDraft(db, "p", { revision: 0, draft: chat("two"), actor: "user:b" }, QUOTA),
    ).rejects.toBeInstanceOf(DraftConflictError);
    await expect(
      saveDraft(
        db,
        "p",
        { revision: 1, draft: { kind: "decision", questions: {} }, actor: ACTOR },
        QUOTA,
      ),
    ).rejects.toBeInstanceOf(PromptKindError);
    await expect(
      saveDraft(db, "missing", { revision: 0, draft: chat("x"), actor: ACTOR }, QUOTA),
    ).rejects.toBeInstanceOf(PromptNotFoundError);
    expect((await getPrompt(db, "p"))?.prompt.draft).toEqual(chat("one"));
  });

  it("publishes numbered versions after checking the draft, and refuses one unchanged or stale", async () => {
    await using db = await tenantDb();
    await createPrompt(db, { name: "p", kind: "chat", actor: ACTOR }, QUOTA);
    // An empty draft, and one whose variables do not match its text, list every problem.
    await expect(publishPrompt(db, "p", { revision: 0, actor: ACTOR }, QUOTA)).rejects.toThrow(
      NotPublishableError,
    );
    await saveDraft(
      db,
      "p",
      { revision: 0, draft: chat("Hi {{user}}", ["tone"]), actor: ACTOR },
      QUOTA,
    );
    await expect(
      publishPrompt(
        db,
        "p",
        { revision: 1, actor: ACTOR, moreProblems: () => ["the model runs no conversations"] },
        QUOTA,
      ),
    ).rejects.toThrow(/\{\{user\}\}.*tone is declared.*the model runs no conversations/);

    expect(await publish(db, "p", chat("Hi {{user}}", ["user"]))).toBe(1);
    // Publishing again without a change is refused; the draft is version 1.
    await expect(
      publishPrompt(db, "p", { revision: 2, actor: ACTOR }, QUOTA),
    ).rejects.toBeInstanceOf(PromptUnchangedError);
    await expect(
      publishPrompt(db, "p", { revision: 1, actor: ACTOR }, QUOTA),
    ).rejects.toBeInstanceOf(DraftConflictError);
    expect(await publish(db, "p", chat("Hello {{user}}", ["user"]))).toBe(2);
    expect(await publish(db, "p", chat("Hi {{user}}", ["user"]))).toBe(3);

    const stored = await getPrompt(db, "p");
    expect(stored?.prompt.latestVersion).toBe(3);
    expect(stored?.prompt.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(stored?.prompt.versions[0]).toMatchObject({ note: null, publishedBy: ACTOR });
    const second = await getPromptVersion(db, "p", 2);
    expect(second).toMatchObject({ name: "p", version: 2, body: chat("Hello {{user}}", ["user"]) });
    // A later save leaves published versions as they were.
    await saveDraft(db, "p", { revision: 4, draft: chat("changed"), actor: ACTOR }, QUOTA);
    expect((await getPromptVersion(db, "p", 2))?.body).toEqual(chat("Hello {{user}}", ["user"]));
  });

  it("resolves a version by number, label or latest; labels move and latest cannot be set", async () => {
    await using db = await tenantDb();
    await createPrompt(db, { name: "p", kind: "chat", actor: ACTOR }, QUOTA);
    await publish(db, "p", chat("one"));
    await publish(db, "p", chat("two"));
    expect((await getPromptVersion(db, "p", "latest"))?.version).toBe(2);
    expect(await getPromptVersion(db, "p", "production")).toBeUndefined();
    expect(await getPromptVersion(db, "p", 3)).toBeUndefined();
    expect(await getPromptVersion(db, "q", 1)).toBeUndefined();

    const labelled = await setPromptLabel(db, "p", {
      label: "production",
      version: 1,
      actor: ACTOR,
    });
    expect(labelled.prompt.labels).toEqual({ production: 1 });
    expect((await getPromptVersion(db, "p", "production"))?.version).toBe(1);
    await setPromptLabel(db, "p", { label: "production", version: 2, actor: ACTOR });
    expect((await getPromptVersion(db, "p", "production"))?.body).toEqual(chat("two"));

    await expect(
      setPromptLabel(db, "p", { label: "latest", version: 1, actor: ACTOR }),
    ).rejects.toBeInstanceOf(ReservedLabelError);
    await expect(removePromptLabel(db, "p", "latest")).rejects.toBeInstanceOf(ReservedLabelError);
    await expect(
      setPromptLabel(db, "p", { label: "staging", version: 9, actor: ACTOR }),
    ).rejects.toBeInstanceOf(PromptNotFoundError);

    await removePromptLabel(db, "p", "production");
    expect(await getPromptVersion(db, "p", "production")).toBeUndefined();
    await expect(removePromptLabel(db, "p", "production")).rejects.toBeInstanceOf(
      PromptNotFoundError,
    );
  });

  it("renames and deletes a prompt only before its first publish", async () => {
    await using db = await tenantDb();
    await createPrompt(db, { name: "draft", kind: "chat", actor: ACTOR }, QUOTA);
    await createPrompt(db, { name: "taken", kind: "chat", actor: ACTOR }, QUOTA);
    await expect(renamePrompt(db, "draft", "taken")).rejects.toBeInstanceOf(PromptNameTakenError);
    expect((await renamePrompt(db, "draft", "team/draft")).prompt.name).toBe("team/draft");
    await deletePrompt(db, "team/draft");
    expect(await getPrompt(db, "team/draft")).toBeUndefined();

    await publish(db, "taken", chat("hi"));
    await expect(renamePrompt(db, "taken", "other")).rejects.toBeInstanceOf(PromptPublishedError);
    await expect(deletePrompt(db, "taken")).rejects.toBeInstanceOf(PromptPublishedError);
    await expect(deletePrompt(db, "missing")).rejects.toBeInstanceOf(PromptNotFoundError);
  });

  it("keeps at most MAX_PROMPTS prompts and MAX_PROMPT_VERSIONS versions", async () => {
    await using db = await tenantDb();
    await db.query(
      `insert into prompts (name, kind, draft, draft_bytes, draft_updated_by)
       select 'p' || n, 'chat', '{"kind":"chat","text":"","guardrails":[],"variables":[]}', 0, 'key:k' from generate_series(1, $1) n`,
      [MAX_PROMPTS - 1],
    );
    await createPrompt(db, { name: "last", kind: "chat", actor: ACTOR }, QUOTA);
    await expect(
      createPrompt(db, { name: "one-more", kind: "chat", actor: ACTOR }, QUOTA),
    ).rejects.toBeInstanceOf(PromptLimitError);

    await deletePrompt(db, "p1");
    await createPrompt(db, { name: "full", kind: "chat", actor: ACTOR }, QUOTA);
    await db.query(
      `insert into prompt_versions (prompt_id, version, body, bytes, published_by)
       select p.id, n, jsonb_build_object('kind', 'chat', 'text', n::text), 0, 'key:k'
         from prompts p, generate_series(1, $1) n where p.name = 'full'`,
      [MAX_PROMPT_VERSIONS],
    );
    await saveDraft(db, "full", { revision: 0, draft: chat("new"), actor: ACTOR }, QUOTA);
    await expect(
      publishPrompt(db, "full", { revision: 1, actor: ACTOR }, QUOTA),
    ).rejects.toBeInstanceOf(PromptLimitError);
  });

  it("counts drafts and versions against the storage quota, with the blob index", async () => {
    await using db = await tenantDb();
    await db.query(
      "insert into blobs (object_key, kind, media_type, size, sha256) values ('t/x/k', 'message', 'application/json', 100, 'x')",
    );
    const small = { storageBytes: 400 };
    await createPrompt(db, { name: "p", kind: "chat", actor: ACTOR }, small);
    const afterCreate = await storedBytes(db);
    expect(afterCreate).toBeGreaterThan(100);
    // A draft that would pass the quota is refused; a smaller one is not.
    await expect(
      saveDraft(db, "p", { revision: 0, draft: chat("x".repeat(400)), actor: ACTOR }, small),
    ).rejects.toBeInstanceOf(StorageQuotaExceededError);
    await saveDraft(db, "p", { revision: 0, draft: chat("hello"), actor: ACTOR }, small);
    const draftBytes = (await storedBytes(db)) - 100;
    // Publishing stores the body again: it fits only when the quota holds both copies.
    await expect(
      publishPrompt(
        db,
        "p",
        { revision: 1, actor: ACTOR },
        { storageBytes: 100 + 2 * draftBytes - 1 },
      ),
    ).rejects.toBeInstanceOf(StorageQuotaExceededError);
    await publishPrompt(
      db,
      "p",
      { revision: 1, actor: ACTOR },
      { storageBytes: 100 + 2 * draftBytes },
    );
    expect(await storedBytes(db)).toBe(100 + 2 * draftBytes);
    // A tenant over its quota may still shrink a draft.
    await saveDraft(db, "p", { revision: 1, draft: chat("hi"), actor: ACTOR }, { storageBytes: 1 });
  });
});
