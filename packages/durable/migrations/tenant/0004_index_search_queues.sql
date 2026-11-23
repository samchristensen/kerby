-- The chat search index's queues (ADR 0021): `index` builds it after turns, `search` embeds a query with the tenant's key.
-- Each has its own lane in the worker, so neither takes a turn's slot.
select absurd.create_queue('index');
select absurd.create_queue('search');
