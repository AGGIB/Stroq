// The policy a live check is run under, named and written down.
//
// A stored check means something only for the policy it was run under, so the policy gets a digest
// that changes when it does (`stale` in `states.ts` compares them). And the hook that the host runs
// during a check has to judge under exactly the policy the check expects, or the two would disagree for
// no reason a person could find: the policy is written where that hook reads it.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { stableStringify, type Policy } from '@stroq/core';
import { stringify } from 'yaml';
import { writePrivateFileAtomic } from './private-file.js';

/**
 * The sha256 of the policy as a value, not as a file: the same for the default policy, which has no
 * file, and for a policy that says the same thing in another order of keys. The order of the rules is
 * part of it, because the first rule that matches decides.
 */
export const policySha256 = (policy: Policy): string =>
  createHash('sha256').update(stableStringify(policy)).digest('hex');

/**
 * Writes `policy` as `policy.yaml` in a Stroq home, which is where `stroq hook` reads the user's
 * policy from. The home is a throwaway one made for a check; the user's own is never written to.
 */
export function writePolicy(stroqHome: string, policy: Policy): void {
  writePrivateFileAtomic(join(stroqHome, 'policy.yaml'), stringify(policy));
}
