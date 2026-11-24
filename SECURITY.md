# Security

Kerby is pre-1.0 and built in public. If you find a vulnerability, please report it privately: on the repository's
**Security** tab, choose **Report a vulnerability** (GitHub private vulnerability reporting). Please do not open a public
issue for it.

Include what you found, how to reproduce it, and the version (an image tag `sha-<commit>`, or the SDK's npm version).

Useful context: an install serves one owner, but the tenant boundary is kept and a tenant is treated as untrusted
([ADR 0024](docs/adr/0024-self-hosted-single-tenant.md)); secrets are sealed with keys derived from `KERBY_SECRET_KEY`,
never stored in the clear. `docs/deploy.md` lists what not to do with an install.
