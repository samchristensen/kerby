// Control's housekeeping: export retention, tenant event and task retention, and the bucket backup at a fixed UTC hour, and an hourly check that a
// backup succeeded within 26 hours (it catches a run that never happened). Every control instance keeps the timers; the
// backup's advisory lock lets one of them copy.
import { alert, errorFields, log } from "@kerby/observability";
import { backupBuckets, checkBackupFreshness } from "../service/backup.ts";
import { deleteExpiredExports } from "../service/export.ts";
import { pruneTenants } from "../service/retention.ts";
import { ConflictError, type ControlDeps } from "../types/index.ts";

/** Quiet hours for tenants in the Americas and Europe. */
const NIGHTLY_HOUR_UTC = 3;
const FRESHNESS_INTERVAL_MS = 60 * 60 * 1000;

/** Milliseconds from `now` to the next `hour`:00 UTC (a full day when `now` is exactly on it). */
export function untilNext(now: Date, hour: number): number {
  const next = new Date(now);
  next.setUTCHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

async function nightly(deps: ControlDeps): Promise<void> {
  await deleteExpiredExports(deps).catch((error: unknown) =>
    alert("export retention failed", errorFields(error)),
  );
  await pruneTenants(deps).catch((error: unknown) =>
    alert("tenant retention failed", errorFields(error)),
  );
  await backupBuckets(deps).catch((error: unknown) => {
    if (error instanceof ConflictError)
      log("info", "bucket backup skipped: another instance runs it");
    else alert("bucket backup failed", errorFields(error));
  });
}

/**
 * Delete expired exports and check the backup's freshness now, then check it every hour and run the nightly work every
 * day at `NIGHTLY_HOUR_UTC`. `stop()` clears the timers and waits for the work under way.
 */
export function startNightly(deps: ControlDeps): { stop(): Promise<void> } {
  const startedAt = deps.now();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const running = new Set<Promise<void>>();
  const track = (work: Promise<void>): Promise<void> => {
    const tracked = work.finally(() => running.delete(tracked));
    running.add(tracked);
    return tracked;
  };
  const checkFreshness = () =>
    checkBackupFreshness(deps, startedAt).catch((error: unknown) =>
      alert("bucket backup freshness check failed", errorFields(error)),
    );

  track(
    deleteExpiredExports(deps).then(
      () => {},
      (error: unknown) => alert("export retention failed", errorFields(error)),
    ),
  );
  track(checkFreshness());
  const freshness = setInterval(() => track(checkFreshness()), FRESHNESS_INTERVAL_MS);
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(
      () => {
        void track(nightly(deps)).finally(schedule);
      },
      untilNext(deps.now(), NIGHTLY_HOUR_UTC),
    );
  };
  schedule();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(freshness);
      await Promise.all(running);
    },
  };
}
