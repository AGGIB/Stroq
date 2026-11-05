// The key index of the run in progress, held in memory for the code that checks transcripts.
//
// A job is a small plain object and goes to a worker thread for every transcript; the keys (which hold
// values) must not go with each one, and must not be read again by each thread from the files. So the
// run registers the index once: a worker thread gets it when it is started (`worker.ts`), and a run in
// this process finds it here. A job names the digest it expects, so a job that meets another index is
// refused and not answered with a wrong one. Nothing here is written anywhere.
import type { KeyIndexData } from './key-index.js';

export interface RegisteredIndex {
  readonly digest: string;
  readonly data: KeyIndexData;
}

let current: RegisteredIndex | null = null;

/** Registers the index for the run now starting; null forgets it. */
export function registerKeyIndex(index: RegisteredIndex | null): void {
  current = index;
}

/** The index registered in this thread, or null. */
export const registeredKeyIndex = (): RegisteredIndex | null => current;
