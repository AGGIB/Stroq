import type { ZodError } from 'zod';
import { quotePath } from './safe-path.js';

/**
 * What is wrong with a record that did not match its schema, in words of ours.
 *
 * The message that zod writes quotes what it found, and for an unknown key that is the key: a name
 * chosen by whoever wrote the record, which may hold the escape that starts a terminal sequence or a
 * direction override. A record can come from outside (a README, a lock file that somebody else
 * wrote), so the text of a `ZodError` is never printed. This says where each fault is, by the path of
 * the field (written out as a path of a file is, so that it cannot act on a terminal), and which kind
 * of fault it is, from a fixed list.
 */

/** At most this many faults are told; a record with more has a first one that is enough. */
const MAX_FAULTS = 5;

const KINDS: Readonly<Record<string, string>> = {
  unrecognized_keys: 'a field that is not part of the record',
  invalid_type: 'a value of the wrong kind',
  invalid_value: 'a value that is not one of those allowed',
  invalid_union: 'a value that matches none of the kinds of record',
  too_big: 'a value that is too long or too big',
  too_small: 'a value that is empty or too small',
  invalid_format: 'a value that is not written as it should be',
  custom: 'a value that breaks a rule of the record',
};

function where(path: readonly PropertyKey[]): string {
  return path.length === 0 ? 'the record' : quotePath(path.map(String).join('.'));
}

export function schemaFault(error: ZodError): string {
  const faults = error.issues.slice(0, MAX_FAULTS).map((issue) => {
    const kind = KINDS[issue.code] ?? 'a value that is not valid';
    return `${where(issue.path)}: ${kind}`;
  });
  const more = error.issues.length - faults.length;
  return `${faults.join('; ')}${more > 0 ? `; and ${more} more` : ''}`;
}
