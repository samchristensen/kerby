// Control's housekeeping: tenant event and task retention, at a fixed UTC hour.
import { errorFields, log } from "@kerby/observability";
import { pruneTenants } from "../service/retention.ts";
import type { ControlDeps } from "../types/index.ts";

/** A quiet hour in the Americas and Europe. */
const NIGHTLY_HOUR_UTC = 3;

/** Milliseconds from `now` to the next `hour`:00 UTC (a full day when `now` is exactly on it). */
export function untilNext(now: Date, hour: number): number {
  const next = new Date(now);
  next.setUTCHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

/** Run retention every day at `NIGHTLY_HOUR_UTC`. `stop()` clears the timer and waits for a run under way. */
export function startNightly(deps: ControlDeps): { stop(): Promise<void> } {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running: Promise<unknown> = Promise.resolve();
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(
      () => {
        // pruneTenants alerts on a failing tenant; anything else it throws is logged here.
        running = pruneTenants(deps)
          .catch((error: unknown) => log("error", "tenant retention failed", errorFields(error)))
          .finally(schedule);
      },
      untilNext(new Date(), NIGHTLY_HOUR_UTC),
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
