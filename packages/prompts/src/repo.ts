// The prompt tables (ADR 0017). Every write that depends on the prompt's state locks its row first, so a save, a publish
// and a label move on one prompt serialize. Error messages never quote the prompt's name: the caller knows it.
import {
  LATEST_LABEL,
  MAX_PROMPT_VERSIONS,
  MAX_PROMPTS,
  type Prompt,
  type PromptBody,
  type PromptKind,
  type PromptSummary,
  type PromptVersion,
  type PromptVersionSelector,
  type PromptVersionSummary,
} from "@kerby/contracts";
import type { TenantDb, TenantQueryable, TenantTx } from "@kerby/db";
import { errorCode } from "@kerby/observability";
import {
  DraftConflictError,
  NotPublishableError,
  PromptKindError,
  PromptLimitError,
  PromptNameTakenError,
  PromptNotFoundError,
  PromptPublishedError,
  PromptUnchangedError,
  ReservedLabelError,
} from "./errors.ts";
import { StorageQuotaExceededError, storedBytes } from "./storage.ts";
import { publishProblems } from "./template.ts";

/** A prompt and its id, which the audit log names it by (its name is the tenant's words). */
export type StoredPrompt = { id: string; prompt: Prompt };

/** `limits.storageBytes` of the tenant, or the service's default. */
type Quota = { storageBytes: number };

/** A body's size as stored, the unit the storage quota counts. */
const bodyBytes = (body: PromptBody): number => Buffer.byteLength(JSON.stringify(body));

function refuseOverQuota(stored: number, adding: number, quota: Quota): void {
  if (adding <= 0 || stored + adding <= quota.storageBytes) return;
  throw new StorageQuotaExceededError(
    `the tenant stores ${stored} bytes and this prompt adds ${adding}, past its storage quota of ${quota.storageBytes} bytes; delete conversations or ask the operator to raise limits.storageBytes`,
  );
}

type SummaryRow = {
  id: string;
  name: string;
  kind: PromptKind;
  latest_version: number | null;
  labels: Record<string, number>;
  created_at: Date;
  updated_at: Date;
};

const SUMMARY_COLUMNS = `p.id, p.name, p.kind, p.created_at, p.updated_at,
  (select max(v.version) from prompt_versions v where v.prompt_id = p.id) as latest_version,
  (select coalesce(jsonb_object_agg(l.label, l.version), '{}'::jsonb) from prompt_labels l where l.prompt_id = p.id) as labels`;

const summaryFromRow = (row: SummaryRow): PromptSummary => ({
  name: row.name,
  kind: row.kind,
  latestVersion: row.latest_version,
  labels: row.labels,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

type VersionSummaryRow = {
  version: number;
  note: string | null;
  published_at: Date;
  published_by: string;
};

const versionSummaryFromRow = (row: VersionSummaryRow): PromptVersionSummary => ({
  version: row.version,
  note: row.note,
  publishedAt: row.published_at.toISOString(),
  publishedBy: row.published_by,
});

/** The tenant's prompts by name, of one kind or both. */
export async function listPrompts(
  db: TenantQueryable,
  query: { kind?: PromptKind | undefined } = {},
): Promise<PromptSummary[]> {
  const { rows } = await db.query<SummaryRow>(
    `select ${SUMMARY_COLUMNS} from prompts p where ($1::text is null or p.kind = $1) order by p.name`,
    [query.kind ?? null],
  );
  return rows.map(summaryFromRow);
}

/** The prompt with its draft and every version (newest first, without bodies). */
export async function getPrompt(
  db: TenantQueryable,
  name: string,
): Promise<StoredPrompt | undefined> {
  const { rows } = await db.query<
    SummaryRow & {
      draft: PromptBody;
      draft_revision: number;
      draft_updated_at: Date;
      draft_updated_by: string;
    }
  >(
    `select ${SUMMARY_COLUMNS}, p.draft, p.draft_revision, p.draft_updated_at, p.draft_updated_by
       from prompts p where p.name = $1`,
    [name],
  );
  const row = rows[0];
  if (!row) return undefined;
  const versions = await db.query<VersionSummaryRow>(
    "select version, note, published_at, published_by from prompt_versions where prompt_id = $1 order by version desc",
    [row.id],
  );
  return {
    id: row.id,
    prompt: {
      ...summaryFromRow(row),
      draft: row.draft,
      draftRevision: row.draft_revision,
      draftUpdatedAt: row.draft_updated_at.toISOString(),
      draftUpdatedBy: row.draft_updated_by,
      versions: versions.rows.map(versionSummaryFromRow),
    },
  };
}

/** `getPrompt` for a row this transaction just wrote: it is there. */
async function reload(tx: TenantTx, name: string): Promise<StoredPrompt> {
  const stored = await getPrompt(tx, name);
  if (!stored) throw new Error("a prompt written in this transaction is missing");
  return stored;
}

type LockedPrompt = {
  id: string;
  kind: PromptKind;
  draft: PromptBody;
  draft_revision: number;
  draft_bytes: string;
  published: boolean;
};

/** Lock the prompt's row for the rest of the transaction; refused when there is none. */
async function lockPrompt(tx: TenantTx, name: string): Promise<LockedPrompt> {
  const { rows } = await tx.query<LockedPrompt>(
    `select id, kind, draft, draft_revision, draft_bytes::text as draft_bytes,
            exists (select 1 from prompt_versions v where v.prompt_id = prompts.id) as published
       from prompts where name = $1 for update`,
    [name],
  );
  const row = rows[0];
  if (!row) throw new PromptNotFoundError("no prompt by that name");
  return row;
}

function refuseStaleRevision(locked: LockedPrompt, revision: number): void {
  if (locked.draft_revision !== revision)
    throw new DraftConflictError(
      `the draft is at revision ${locked.draft_revision}, not ${revision}: someone saved it since you loaded it; load it again and redo your change`,
    );
}

const nameConflict = (error: unknown): unknown =>
  errorCode(error) === "23505"
    ? new PromptNameTakenError("another prompt has that name: choose another")
    : error;

/** A new prompt with an empty draft, or `draft`. At most `MAX_PROMPTS` per tenant; the draft counts against the quota. */
export async function createPrompt(
  db: TenantDb,
  input: { name: string; kind: PromptKind; draft?: PromptBody | undefined; actor: string },
  quota: Quota,
): Promise<StoredPrompt> {
  const draft: PromptBody =
    input.draft ??
    (input.kind === "chat"
      ? { kind: "chat", text: "", guardrails: [], variables: [] }
      : { kind: "decision", questions: {} });
  if (draft.kind !== input.kind)
    throw new PromptKindError(
      `the draft is a ${draft.kind} body: a ${input.kind} prompt needs a ${input.kind} draft`,
    );
  const bytes = bodyBytes(draft);
  return db.transaction(async (tx) => {
    // Creations serialize, so two at once cannot both take the last place under the limit.
    await tx.query("select pg_advisory_xact_lock(hashtext('kerby.prompts.create'))");
    const { rows } = await tx.query<{ count: number }>(
      "select count(*)::int as count from prompts",
    );
    if ((rows[0]?.count ?? 0) >= MAX_PROMPTS)
      throw new PromptLimitError(
        `a tenant keeps at most ${MAX_PROMPTS} prompts: delete an unpublished one first`,
      );
    refuseOverQuota(await storedBytes(tx), bytes, quota);
    await tx
      .query(
        `insert into prompts (name, kind, draft, draft_bytes, draft_updated_by)
         values ($1, $2, $3::jsonb, $4, $5)`,
        [input.name, input.kind, JSON.stringify(draft), bytes, input.actor],
      )
      .catch((error: unknown) => {
        throw nameConflict(error);
      });
    return reload(tx, input.name);
  });
}

/**
 * Replace the draft, if it is still at `revision` (else `DraftConflictError`): one more revision. A draft of the other
 * kind is refused. A draft that grows counts against the quota.
 */
export async function saveDraft(
  db: TenantDb,
  name: string,
  input: { revision: number; draft: PromptBody; actor: string },
  quota: Quota,
): Promise<StoredPrompt> {
  const bytes = bodyBytes(input.draft);
  return db.transaction(async (tx) => {
    const locked = await lockPrompt(tx, name);
    if (input.draft.kind !== locked.kind)
      throw new PromptKindError(
        `this is a ${locked.kind} prompt: send a draft of kind "${locked.kind}"`,
      );
    refuseStaleRevision(locked, input.revision);
    refuseOverQuota(await storedBytes(tx), bytes - Number(locked.draft_bytes), quota);
    await tx.query(
      `update prompts set draft = $2::jsonb, draft_bytes = $3, draft_revision = draft_revision + 1,
              draft_updated_at = now(), draft_updated_by = $4, updated_at = now()
        where id = $1`,
      [locked.id, JSON.stringify(input.draft), bytes, input.actor],
    );
    return reload(tx, name);
  });
}

/**
 * Freeze the draft at `revision` as the next version (the highest plus one). Refused, in this order, when the draft
 * moved on, fails `publishProblems` or `moreProblems` (every problem listed), equals the latest version, would pass
 * `MAX_PROMPT_VERSIONS`, or would pass the storage quota.
 */
export async function publishPrompt(
  db: TenantDb,
  name: string,
  input: {
    revision: number;
    note?: string | undefined;
    actor: string;
    /** Checks that need the deployment's settings (which providers exist). */
    moreProblems?: ((body: PromptBody) => string[]) | undefined;
  },
  quota: Quota,
): Promise<{ id: string; version: PromptVersionSummary }> {
  return db.transaction(async (tx) => {
    const locked = await lockPrompt(tx, name);
    refuseStaleRevision(locked, input.revision);
    const problems = [
      ...publishProblems(locked.draft),
      ...(input.moreProblems?.(locked.draft) ?? []),
    ];
    if (problems.length > 0) throw new NotPublishableError(problems);
    const latest = await tx.query<{ version: number; same: boolean }>(
      `select v.version, v.body = p.draft as same
         from prompt_versions v join prompts p on p.id = v.prompt_id
        where v.prompt_id = $1 order by v.version desc limit 1`,
      [locked.id],
    );
    const highest = latest.rows[0];
    if (highest?.same)
      throw new PromptUnchangedError(
        `the draft is version ${highest.version} already: change it before publishing`,
      );
    if ((highest?.version ?? 0) >= MAX_PROMPT_VERSIONS)
      throw new PromptLimitError(
        `a prompt keeps at most ${MAX_PROMPT_VERSIONS} versions: publish under a new name`,
      );
    refuseOverQuota(await storedBytes(tx), Number(locked.draft_bytes), quota);
    const { rows } = await tx.query<VersionSummaryRow>(
      `insert into prompt_versions (prompt_id, version, body, bytes, note, published_by)
       select id, $2, draft, draft_bytes, $3, $4 from prompts where id = $1
       returning version, note, published_at, published_by`,
      [locked.id, (highest?.version ?? 0) + 1, input.note ?? null, input.actor],
    );
    await tx.query("update prompts set updated_at = now() where id = $1", [locked.id]);
    const row = rows[0];
    if (!row) throw new Error("version insert returned no row");
    return { id: locked.id, version: versionSummaryFromRow(row) };
  });
}

/** One published version, by number or label (`latest` is the highest); undefined when there is no such version. */
export async function getPromptVersion(
  db: TenantQueryable,
  name: string,
  selector: PromptVersionSelector,
): Promise<PromptVersion | undefined> {
  const { rows } = await db.query<VersionSummaryRow & { name: string; body: PromptBody }>(
    `select p.name, v.version, v.body, v.note, v.published_at, v.published_by
       from prompts p join prompt_versions v on v.prompt_id = p.id
      where p.name = $1
        and v.version = case
              when $2::int is not null then $2::int
              when $3::text = '${LATEST_LABEL}' then (select max(m.version) from prompt_versions m where m.prompt_id = p.id)
              else (select l.version from prompt_labels l where l.prompt_id = p.id and l.label = $3::text)
            end`,
    [
      name,
      typeof selector === "number" ? selector : null,
      typeof selector === "string" ? selector : null,
    ],
  );
  const row = rows[0];
  return row && { ...versionSummaryFromRow(row), name: row.name, body: row.body };
}

function refuseLatest(label: string): void {
  if (label === LATEST_LABEL)
    throw new ReservedLabelError(
      `"${LATEST_LABEL}" always means the highest version: it cannot be set or removed; use another label`,
    );
}

/** Point `label` at `version` (an existing one), creating or moving it. */
export async function setPromptLabel(
  db: TenantDb,
  name: string,
  input: { label: string; version: number; actor: string },
): Promise<StoredPrompt> {
  refuseLatest(input.label);
  return db.transaction(async (tx) => {
    const locked = await lockPrompt(tx, name);
    const exists = await tx.query(
      "select 1 from prompt_versions where prompt_id = $1 and version = $2",
      [locked.id, input.version],
    );
    if (exists.rowCount === 0)
      throw new PromptNotFoundError(`the prompt has no version ${input.version}`);
    await tx.query(
      `insert into prompt_labels (prompt_id, label, version, updated_by) values ($1, $2, $3, $4)
       on conflict (prompt_id, label) do update
         set version = excluded.version, updated_at = now(), updated_by = excluded.updated_by`,
      [locked.id, input.label, input.version, input.actor],
    );
    await tx.query("update prompts set updated_at = now() where id = $1", [locked.id]);
    return reload(tx, name);
  });
}

/** Remove `label`; the prompt's id, for the audit log. */
export async function removePromptLabel(
  db: TenantDb,
  name: string,
  label: string,
): Promise<{ id: string }> {
  refuseLatest(label);
  return db.transaction(async (tx) => {
    const locked = await lockPrompt(tx, name);
    const removed = await tx.query(
      "delete from prompt_labels where prompt_id = $1 and label = $2",
      [locked.id, label],
    );
    if (removed.rowCount === 0) throw new PromptNotFoundError("the prompt has no such label");
    await tx.query("update prompts set updated_at = now() where id = $1", [locked.id]);
    return { id: locked.id };
  });
}

function refusePublished(locked: LockedPrompt, doing: string): void {
  if (locked.published)
    throw new PromptPublishedError(
      `the prompt has a published version, so clients may use its name: it cannot be ${doing}; create a new prompt instead`,
    );
}

/** Give a prompt that has no published version a new name. */
export async function renamePrompt(
  db: TenantDb,
  name: string,
  newName: string,
): Promise<StoredPrompt> {
  return db.transaction(async (tx) => {
    const locked = await lockPrompt(tx, name);
    refusePublished(locked, "renamed");
    await tx
      .query("update prompts set name = $2, updated_at = now() where id = $1", [locked.id, newName])
      .catch((error: unknown) => {
        throw nameConflict(error);
      });
    return reload(tx, newName);
  });
}

/** Delete a prompt that has no published version; its id, for the audit log. */
export async function deletePrompt(db: TenantDb, name: string): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const locked = await lockPrompt(tx, name);
    refusePublished(locked, "deleted");
    await tx.query("delete from prompts where id = $1", [locked.id]);
    return { id: locked.id };
  });
}
