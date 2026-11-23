// A subscription's health at a glance. Server-safe: no hooks here.
import type { Subscription } from "@kerby/contracts";
import { formatDateTime } from "../../../../_components/format.ts";
import { Badge } from "../../../../_components/ui.tsx";

export function SubscriptionState({ subscription }: { subscription: Subscription }) {
  if (subscription.state === "disabled") {
    return (
      <span title={subscription.disabledReason ?? undefined}>
        <Badge tone="zinc">Disabled</Badge>
      </span>
    );
  }
  if (subscription.failingSince) {
    return (
      <span title={`Every delivery has failed since ${formatDateTime(subscription.failingSince)}`}>
        <Badge tone="red">Failing</Badge>
      </span>
    );
  }
  return <Badge tone="green">Active</Badge>;
}
