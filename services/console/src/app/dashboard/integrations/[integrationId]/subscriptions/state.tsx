// A subscription's health at a glance. Server-safe: no hooks here.
import type { Subscription } from "@kerby/contracts";
import { formatDateTime } from "../../../../_components/format.ts";
import { Badge } from "../../../../_components/ui.tsx";

export function SubscriptionState({ subscription }: { subscription: Subscription }) {
  if (subscription.state === "disabled") {
    return (
      <span title={subscription.disabledReason ?? undefined}>
        <Badge tone="neutral">Disabled</Badge>
      </span>
    );
  }
  if (subscription.failingSince) {
    return (
      <span title={`Every delivery has failed since ${formatDateTime(subscription.failingSince)}`}>
        <Badge tone="danger">Failing</Badge>
      </span>
    );
  }
  return <Badge tone="live">Active</Badge>;
}
