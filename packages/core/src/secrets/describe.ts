import type { SecretHit } from '../types.js';
import { neutralizeControls } from '../util/controls.js';

/** One sentence for hook reasons and `stroq why`; never includes the value. */
export function describeSecretHit(hit: SecretHit): string {
  // A project's `.env` names its own keys, and the repository may be anyone's.
  const name = neutralizeControls(hit.name);
  const source = neutralizeControls(hit.source);
  if (hit.canary) {
    return `the arguments contain the value of ${name}, a Stroq canary; the session is now marked suspect.`;
  }
  return `the arguments contain the value of ${name} from ${source}.`;
}
