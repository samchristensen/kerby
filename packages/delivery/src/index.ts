// The port between Kerby and anywhere events are pushed (ADR 0019). Types only: nothing here names a destination's
// protocol or SDK. An adapter (`packages/delivery-<kind>`) implements one kind; only a service's `src/index.ts` wires
// adapters into a `Destinations` registry, and everything else sees these types. A destination never sees a tenant,
// integration or subscription id: the dispatcher holds those.
import type { DestinationConfig } from "@kerby/contracts";

type DestinationKind = DestinationConfig["kind"];

/** The config of one kind, as the subscription stores it (`packages/contracts` `DestinationConfigSchema`). */
type ConfigOf<K extends DestinationKind> = Extract<DestinationConfig, { kind: K }>;

/** One event as it leaves Kerby: its id (the dedupe key), and the exact JSON body every subscriber gets. */
export type WireEvent = { id: string; body: string };

/** What the destination answered, at most 1 KiB of it: for the tenant's delivery log, never for Kerby's logs. */
type Answer = { status: number | null; response: string | null };

export type DeliveryOutcome =
  /** Accepted: every event of the batch. */
  | ({ type: "delivered" } & Answer)
  /** Not accepted; the dispatcher retries. `error` says why, for the delivery log. */
  | ({ type: "failed"; error: string } & Answer)
  /** The destination says it will never accept (an HTTP 410): the subscription is disabled. */
  | ({ type: "gone"; error: string } & Answer);

export type Destination<K extends DestinationKind> = {
  readonly kind: K;
  /** Events one delivery may carry; the dispatcher never sends more. */
  readonly maxBatch: number;
  /** A new signing or access secret for a subscription, shown to the tenant once. */
  newSecret(): string;
  /** Why Kerby will not deliver to `config` (a message for the tenant), or undefined when it will. */
  check(config: ConfigOf<K>): string | undefined;
  /**
   * Deliver `events` (at most `maxBatch`). `secrets` holds the current secret first, then any previous one still valid
   * after a rotation. Never throws for the destination's own failures: those are outcomes.
   */
  deliver(request: {
    config: ConfigOf<K>;
    secrets: readonly string[];
    events: readonly WireEvent[];
    signal: AbortSignal;
  }): Promise<DeliveryOutcome>;
};

/** One adapter per kind: what a composition root builds and hands down. */
export type Destinations = { readonly [K in DestinationKind]: Destination<K> };
