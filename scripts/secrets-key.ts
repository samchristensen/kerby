// Make secret keys (`make secrets-key`). The private key goes to the workers (SECRETS_PRIVATE_KEYS), the public key to
// the api (SECRETS_PUBLIC_KEY): losing the private key strands every tenant model key sealed to it, so keep a copy.
// The delivery pair is apart (ADR 0019): its private key goes to the dispatcher (DELIVERY_SECRETS_PRIVATE_KEYS) and opens
// subscriptions' signing secrets, its public key to the api (DELIVERY_SECRETS_PUBLIC_KEY).
// TENANT_DB_KEYS seals tenant database passwords and is held by control, api, worker and dispatcher (ADR 0009).
import { generateBoxKey, generateSecretsKeyPair } from "@kerby/secrets";

const secrets = generateSecretsKeyPair();
console.log(`SECRETS_PRIVATE_KEYS=${secrets.privateKey}`);
console.log(`SECRETS_PUBLIC_KEY=${secrets.publicKey}`);
const delivery = generateSecretsKeyPair();
console.log(`DELIVERY_SECRETS_PRIVATE_KEYS=${delivery.privateKey}`);
console.log(`DELIVERY_SECRETS_PUBLIC_KEY=${delivery.publicKey}`);
console.log(`TENANT_DB_KEYS=${generateBoxKey()}`);
