// Control's daily housekeeping: export retention and the bucket backup, at a fixed UTC hour. Every control instance
// keeps the timer; the backup's advisory lock lets one of them copy.
import { alert, errorFields, log } from "@kerby/observability";
import { backupBuckets } from "../service/backup.ts";
import { deleteExpiredExports } from "../service/export.ts";
import { ConflictError, type ControlDeps } from "../types/index.ts";

/** Quiet hours for tenants in the Americas and Europe. */
const NIGHTLY_HOUR_UTC = 3;

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
  await backupBuckets(deps).catch((error: unknown) => {
    if (error instanceof ConflictError)
      log("info", "bucket backup skipped: another instance runs it");
    else alert("bucket backup failed", errorFields(error));
  });
}

/** Delete expired exports now, then run the nightly work every day at `NIGHTLY_HOUR_UTC`. */
export function startNightly(deps: ControlDeps): { stop(): Promise<void> } {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running: Promise<void> = deleteExpiredExports(deps).then(
    () => {},
    (error: unknown) => alert("export retention failed", errorFields(error)),
  );
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(
      () => {
        running = nightly(deps).finally(schedule);
      },
      untilNext(deps.now(), NIGHTLY_HOUR_UTC),
    );
  };
  schedule();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
