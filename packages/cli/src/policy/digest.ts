import { createHash } from 'node:crypto';
import { stableStringify, type Policy } from '@stroq/core';

/**
 * The `sha256` of a policy as loaded: of its canonical JSON, not of any file's bytes, so a comment or
 * a reordering in the file does not change it and the built-in policy, which has no file, has one.
 * It is the same hash `stroq attack --json` puts in the `meta` block of its report (`buildMeta`), so a
 * policy shown by one command can be matched to a report of the other.
 */
export const policySha256 = (policy: Policy): string =>
  createHash('sha256').update(stableStringify(policy)).digest('hex');
