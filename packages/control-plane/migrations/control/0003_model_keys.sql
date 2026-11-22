-- Tenants bring their own model keys (ADR 0008). The api stores them sealed to the platform public key and the worker
-- reads them back; neither can open a row without the private key, which only the worker holds. The rows stay
-- invisible to every tenant: the api reads and writes only the verified tenant's rows.
grant select, insert, update, delete on tenant_secrets to kerby_app;
-- Setting or removing a key is audited from the api; the role can append to the log but never read or change it.
grant insert on audit_log to kerby_app;
