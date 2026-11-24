// Make an install's secrets (`make secrets-key`, ADR 0024). KERBY_SECRET_KEY is the only generated secret: every other key
// derives from it, so losing it strands every model key and tool credential the install holds; keep a copy outside the
// host. KERBY_API_KEY is the tenant's first API key, created by control at startup; give it to your application too.
import { newApiKey } from "@kerby/control-plane";
import { generateInstanceSecret } from "@kerby/secrets";

console.log(`KERBY_SECRET_KEY=${generateInstanceSecret()}`);
console.log(`KERBY_API_KEY=${newApiKey().key}`);
