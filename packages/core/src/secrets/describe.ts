import type { SecretHit } from '../types.js';

/** One sentence for hook reasons and `stroq why`; never includes the value. */
export function describeSecretHit(hit: SecretHit): string {
  if (hit.canary) {
    return `the arguments contain the value of ${hit.name}, a Stroq canary; the session is now marked suspect.`;
  }
  return `the arguments contain the value of ${hit.name} from ${hit.source}.`;
}
