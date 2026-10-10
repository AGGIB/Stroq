import { extractEnv, isSecretValue, looksLikeToken } from '@stroq/core';

/**
 * What a name says about the values that hang under it.
 *
 * A JSON key is read ONCE, where it is, and the answer is handed down to every string under it.
 * Reading the key again for each item of a list makes the cost the length of the key times the
 * number of items, and a repository can commit a key of a million characters above a list of
 * hundreds of thousands: that took one call of the reader minutes.
 */

export interface NameFacts {
  /**
   * Core's rule for names applies to this name: it says secret (`token`, `password`, `auth` ...)
   * and is not a location or a label (`_url`, `_path`, `_name` ...). Core owns the list of both, and
   * is asked, so that the two readers of an environment never disagree about a name.
   */
  readonly core: boolean;
  /** The name is that of an authorization header, or holds the word. */
  readonly authorization: boolean;
}

const AUTHORIZATION = 'authorization';

/**
 * A value that passes every test core has for a value (long enough, one piece, no placeholder, no
 * path, no URL), so that when core is asked about it, only the name decides.
 */
const PROBE = 'Zq7Zq7Zq7Zq7Zq7';

/** The longest stretch of a value that is read, as core reads at most this much of a line. */
const MAX_VALUE_CHARS = 4096;

export function nameFacts(name: string): NameFacts {
  return {
    core: extractEnv({ [name]: PROBE }).length > 0,
    authorization: name.toLowerCase().includes(AUTHORIZATION),
  };
}

/**
 * Whether `value`, under a name with these facts, is a secret by core's own rule: a value of a
 * known vendor's shape is one under any name, and any other value that is long enough, in one
 * piece and not a stand-in is one under a name that says secret.
 */
export function secretUnderName(facts: NameFacts, value: string): boolean {
  const read = value.length > MAX_VALUE_CHARS ? value.slice(0, MAX_VALUE_CHARS) : value;
  return isSecretValue(read) && (facts.core || looksLikeToken(read));
}
