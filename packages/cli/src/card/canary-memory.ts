// What the card remembers of looking for planted canaries in the sessions.
//
// A canary `stroq canary` planted whose decoy file is gone has no value to look for: `sent` reads every
// session file for values of a canary's shape and hashes each against the planted ones
// (`session-canaries.ts`). That is a read of all the sessions, and while a planted canary stays missing
// it would be made again on every run. So a file read through to its end with no match is remembered,
// by path, with the size and date it had when it was looked at, for as long as the same canaries are
// missing; a file that grew or changed is read again, and so is every file once another canary is
// missing or found. Paths and numbers are kept; a value never is.
import { lstatSync } from 'node:fs';
import { CANARY_PREFIX } from '../sent/canaries.js';
import type { CanaryMemory } from '../sent/session-canaries.js';
import { MAX_CACHED } from './store.js';
import type { CanaryMemoryFile } from './key-schema.js';

/** A file as it is now, in a word: its size and date; null for anything but a regular file. */
function stampOf(file: string): string | null {
  try {
    const info = lstatSync(file);
    return info.isFile() ? `${info.size}:${info.mtimeMs}` : null;
  } catch {
    return null;
  }
}

/** A path that spells a canary's prefix is not remembered: a name is no place for one. */
const spellsCanary = (file: string): boolean => file.toLowerCase().includes(CANARY_PREFIX);

export interface CanaryNotes {
  /** The memory for the canaries missing now (their signature); what was learned about others is left. */
  readonly memoryFor: (signature: string) => CanaryMemory;
  /** What to keep: this run's, or `previous` when nothing was looked for. */
  readonly result: () => CanaryMemoryFile | null;
  /** Whether this run learned a file. */
  readonly changed: () => boolean;
}

export function canaryNotes(previous: CanaryMemoryFile | null): CanaryNotes {
  let signature: string | null = null;
  let files = new Map<string, string>();
  let changed = false;
  return {
    memoryFor(wanted) {
      signature = wanted;
      files = new Map(previous?.signature === wanted ? Object.entries(previous.files) : []);
      return {
        look(file) {
          const stamp = stampOf(file);
          return {
            clean: stamp !== null && files.get(file) === stamp,
            learn() {
              if (stamp === null || spellsCanary(file)) return;
              files.set(file, stamp);
              changed = true;
            },
          };
        },
      };
    },
    result() {
      if (signature === null) return previous;
      const kept = [...files.entries()].slice(-MAX_CACHED);
      return { signature, files: Object.fromEntries(kept) };
    },
    changed: () => changed,
  };
}
