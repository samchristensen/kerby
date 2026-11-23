-- The `deliveries` queue (ADR 0019): pushing events to subscriptions. The dispatcher claims from it; the worker never
-- does, so a slow customer endpoint cannot hold a turn slot.
select absurd.create_queue('deliveries');
