-- The role the api and worker services connect to the control database as: only what they use, nothing of the
-- operator's (no tenant_secrets, no writes to tenants, no key hashes beyond verification, no audit). The control
-- service gives it a password at startup. The role is cluster-wide; these grants are per database.
do $$
begin
  create role kerby_app nologin;
exception
  -- unique_violation: another database's migration created it at the same moment
  when duplicate_object or unique_violation then null;
end
$$;

grant select on tenants to kerby_app;
-- verify a key (read the hash) and record when it was last used; never change a hash, label or revocation
grant select on api_keys to kerby_app;
grant update (last_used_at) on api_keys to kerby_app;
grant insert on usage to kerby_app;
-- `insert ... on conflict (tenant_id, dedupe_key)` reads the conflict columns
grant select (tenant_id, dedupe_key) on usage to kerby_app;
