// Make a secrets key pair (`make secrets-key`). The private key goes to the workers (SECRETS_PRIVATE_KEYS), the public
// key to the api (SECRETS_PUBLIC_KEY). Losing the private key strands every tenant model key sealed to it: keep a copy.
import { generateSecretsKeyPair } from "@kerby/secrets";

const { privateKey, publicKey } = generateSecretsKeyPair();
console.log(`SECRETS_PRIVATE_KEYS=${privateKey}`);
console.log(`SECRETS_PUBLIC_KEY=${publicKey}`);
