// Canaries found in the sessions themselves, confirmed against the hashes `stroq canary` keeps.
//
// `stroq canary` prints a canary for the user to paste and keeps only a salted hash of it, so a
// canary pasted where `sent` does not read (or a decoy file since deleted) has no value to look
// for. Such a canary still has its shape (`stroq_canary_` and 32 letters or digits): each value of
// that shape in a session's files, or in a Cursor session's rows, is hashed with the salt and
// compared with the hashes of the planted canaries `sent` has no value for. One that matches is a
// key like any other from then on, marked as a canary. This pass runs only when such a canary
// exists, reads the files as raw bytes, and stops once every one is found. Each file, and each
// Cursor session's rows, is hashed to a budget of its own (`MAX_CHECKS_PER_FILE` distinct values):
// a session full of canary-shaped values cannot end the check for the ones after it, and a file
// cut short by its budget is counted and reported, since it may be tampering. Nothing is written.
import { hashSecret } from '@stroq/core';
import { canaryValuesInFile, canaryValuesInText, plantedCanaries } from './canaries.js';
import type { Key, KeySet } from './keys.js';
import { keyName } from './names.js';
import type { SessionRef } from './sessions.js';

/** Where a canary found this way was read from, as a finding names its source. */
export const CANARY_SOURCE = 'stroq canary';

/**
 * Distinct values of a canary's shape hashed in one session file, or in one Cursor session's
 * rows: a session can hold the prefix a million times. Past it the rest of that file is not
 * checked, and the cut is counted.
 */
export const MAX_CHECKS_PER_FILE = 10_000;

/** What checking one file did: whether every planted canary is found now, and whether it was cut. */
interface FileCheck {
  readonly done: boolean;
  readonly cut: boolean;
}

/**
 * `set` with the planted canaries it had no value for and that a session holds, the count of the
 * ones still not found, and the number of session files whose check was cut short by their
 * budget (`canaryCheckCut`). `set` is returned as it is when no canary is missing.
 */
export function withSessionCanaries(
  set: KeySet,
  refs: readonly SessionRef[],
  stroqHome: string | undefined,
): KeySet {
  const planted = stroqHome === undefined ? null : plantedCanaries(stroqHome);
  if (planted === null) return set;
  const known = new Set(
    set.keys.filter((k) => k.canary === true).map((k) => hashSecret(planted.salt, k.value)),
  );
  const missing = new Map([...planted.names].filter(([hash]) => !known.has(hash)));
  if (missing.size === 0) return { ...set, canariesNotFound: 0 };

  const found = new Map<string, string>();
  /** Hands each value of one file to the check, to its budget; what that did. */
  const checkFile = (read: (each: (value: string) => boolean) => boolean): FileCheck => {
    const checked = new Set<string>();
    let cut = false;
    read((value) => {
      if (checked.has(value)) return true;
      if (checked.size >= MAX_CHECKS_PER_FILE) {
        cut = true;
        return false;
      }
      checked.add(value);
      const hash = hashSecret(planted.salt, value);
      if (missing.has(hash)) found.set(hash, value);
      return found.size < missing.size;
    });
    return { done: found.size >= missing.size, cut };
  };

  let cutFiles = 0;
  const sources = refs.flatMap((ref) => [
    ...(ref.cursor === undefined
      ? []
      : [
          (each: (value: string) => boolean) =>
            ref.cursor?.rows.every((row) => canaryValuesInText(row, each)) ?? true,
        ]),
    ...ref.files.map(
      (file) => (each: (value: string) => boolean) => canaryValuesInFile(file, each),
    ),
  ]);
  for (const source of sources) {
    const check = checkFile(source);
    if (check.cut) cutFiles += 1;
    if (check.done) break;
  }

  const added: Key[] = [...found].map(([hash, value]) => ({
    name: keyName(missing.get(hash) ?? 'STROQ_CANARY_KEY'),
    source: CANARY_SOURCE,
    value,
    canary: true,
  }));
  return {
    ...set,
    keys: [...set.keys, ...added],
    canariesNotFound: missing.size - found.size,
    ...(cutFiles > 0 ? { canaryCheckCut: cutFiles } : {}),
  };
}
