import { loadConfig } from "@kerby/config";
import { z } from "zod";

/** The processes one container can run (ADR 0024). */
const ROLES = ["control", "api", "worker", "dispatcher"] as const;
export type Role = (typeof ROLES)[number];

const launcherConfigSchema = z.object({
  /** The install's one generated secret, 32 bytes base64 (`make secrets-key`): every other key derives from it. */
  kerbySecretKey: z.string().min(1),
  /**
   * Kerby's own Postgres, as a superuser (Railway's `${{Postgres.DATABASE_URL}}`): its database is the control
   * database; control makes the tenant databases and the limited roles api, worker and dispatcher connect as.
   */
  databaseUrl: z.url({ protocol: /^postgres(ql)?$/ }),
  /**
   * The processes this container runs, comma separated: all four by default. A second container with
   * `KERBY_ROLES=worker` adds workers; exactly one container in an install runs `control`.
   */
  kerbyRoles: z
    .string()
    .default(ROLES.join(","))
    .transform((value) => [
      ...new Set(
        value
          .split(",")
          .map((role) => role.trim())
          .filter(Boolean),
      ),
    ])
    .pipe(z.array(z.enum(ROLES)).min(1, "name at least one of control, api, worker, dispatcher")),
  /** Where the api listens: the one address an application calls (Railway sets PORT). */
  host: z.string().default("0.0.0.0"),
  port: z.coerce.number().int().min(0).default(8080),
  /** Restart each process when its sources change (the `dev` image target, with the sources mounted). */
  kerbyWatch: z.stringbool().default(false),
});

export type LauncherConfig = z.output<typeof launcherConfigSchema>;

export const loadLauncherConfig = (): LauncherConfig => loadConfig(launcherConfigSchema);
