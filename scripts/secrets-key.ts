// Make secret keys (`make secrets-key`). The private key goes to the workers (SECRETS_PRIVATE_KEYS), the public key to
// the api (SECRETS_PUBLIC_KEY): losing the private key strands every tenant model key sealed to it, so keep a copy.
// TENANT_DB_KEYS seals tenant database passwords and is held by control, api and worker (ADR 0009).
import { generateBoxKey, generateSecretsKeyPair } from "@kerby/secrets";

const { privateKey, publicKey } = generateSecretsKeyPair();
console.log(`SECRETS_PRIVATE_KEYS=${privateKey}`);
console.log(`SECRETS_PUBLIC_KEY=${publicKey}`);
console.log(`TENANT_DB_KEYS=${generateBoxKey()}`);
