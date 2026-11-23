-- When each tenant's task queue next needs a worker to look (ADR 0004), so a worker sweeps only tenants with work due
-- instead of every active tenant. The api marks a tenant due when it enqueues (`hintTenantWork`, with the NOTIFY);
-- a worker, after claiming, writes when the tenant's queue next needs a look (a retry's backoff, a lease that
-- lapses), unless a hint arrived meanwhile (`version`). A slow full sweep remains the backstop for a hint lost
-- between the api's commit and its write.
create table tenant_wakeups (
  tenant_id uuid primary key references tenants (id),
  -- null: nothing known to wait for
  due_at timestamptz,
  -- bumped by every hint; a worker settles `due_at` only if it is the version it read before claiming
  version bigint not null default 0
);
create index tenant_wakeups_due_idx on tenant_wakeups (due_at) where due_at is not null;

-- api hints (insert or bump); worker reads the version, lists due tenants and settles `due_at`. Never deletes.
grant select, insert, update on tenant_wakeups to kerby_app;
