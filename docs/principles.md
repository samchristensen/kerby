# Principles

Human taste, captured once and enforced on every line. **[check]** marks what `make check` enforces; the rest is
review. A review comment you make twice becomes a check.

1. **Boring.** The dull, well-known option. Fewer tools beat a better tool.
2. **Rule of three.** Abstract on the third real use. The exceptions are the ports in ADRs 0002, 0003, and 0004.
3. **Clean cutover.** Replacing something means migrating every caller and deleting the old path in the same change.
4. **Fail loudly.** Parse at the boundary, throw with a clear message, name the bad key. Errors reach the log.
5. **Types are documentation.** Strict TypeScript, no `any` (tsc, Biome) **[check]**.
6. **One door per external system.** Postgres, Absurd, S3, and every harness sit behind one package **[check]**.
7. **Isolation is structural.** A tenant is a database and a key prefix, reached through a handle; nothing relies on remembering a filter **[check: migrations]**.
8. **Tenants are untrusted.** Their code never runs here, their URLs go through the egress guard, their secrets are encrypted, their data stays out of logs.
9. **Persist before act.** What the harness reports is stored before anything depends on it.
10. **The harness is disposable.** Any run can restart from the index with nothing from the previous process.
11. **Versions live once.** Catalog, exact pins **[check]**.
12. **Tests prove behavior.** Real Postgres over mocks; a bug fix ships its regression test; a cross-tenant attempt is a test, not a hope.
13. **Docs move with code.** Stale docs are bugs.
14. **Errors teach.** A check or error says what is wrong, how to fix it, and where the rule lives.
