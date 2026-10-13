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
  invalid_key: 'a name that is not allowed here',
};

/** One fault: where it is, as a dotted path of the fields (empty for the record itself), and what kind. */
export interface SchemaFault {
  readonly path: string;
  readonly kind: string;
}

/** The fault a zod issue stands for, from its path and its code and nothing else it carries. */
export function faultOf(path: readonly PropertyKey[], code: string): SchemaFault {
  return { path: path.map(String).join('.'), kind: KINDS[code] ?? 'a value that is not valid' };
}

/** Every fault of a record, in the order zod found them. */
export function schemaFaults(error: ZodError): readonly SchemaFault[] {
  return error.issues.map((issue) => faultOf(issue.path, issue.code));
}

/** A path written out as the path of a file is, so that it cannot act on a terminal. */
export function whereOf(fault: SchemaFault): string {
  return fault.path === '' ? 'the record' : quotePath(fault.path);
}

export function schemaFault(error: ZodError): string {
  const all = schemaFaults(error);
  const faults = all.slice(0, MAX_FAULTS).map((fault) => `${whereOf(fault)}: ${fault.kind}`);
  const more = all.length - faults.length;
  return `${faults.join('; ')}${more > 0 ? `; and ${more} more` : ''}`;
}
