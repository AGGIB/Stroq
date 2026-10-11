// What a host says about itself in its first message, which no mark can hold against it but a run can.
//
// How it is paid for, and where it runs. A mark is made of what one request shows; these are conditions
// of the whole run, and a host that fails one is not asked anything more. (A host that says it is billed
// to an API key, or to another cloud, is `runProblem`'s: that is a thing it said, and these are things it
// failed to say, or said of another place.)
import { realpathSync } from 'node:fs';
import { plainText } from './plain-text.js';
import type { RunProblem } from './run-problem.js';
import { REASONS, type HostRun } from './types.js';

const MAX_SHOWN_PATH_CHARS = 60;

/**
 * A host that has not said how it is paid for in both of the ways it can be said (its provider and the
 * source of its key) may be billing what the owner did not set aside: `none` for the key is also what a
 * run on a cloud account reports, and `firstParty` for the provider is also what a first-party API key
 * reports. So both have to be there; whether they are right is `runProblem`'s to say.
 */
export function billingProblem(run: HostRun): RunProblem | null {
  if (typeof run.apiProvider === 'string' && typeof run.apiKeySource === 'string') return null;
  return {
    reason: REASONS.billingUnknown,
    detail: 'the host did not say how it is paid for, so no more requests are made of it',
  };
}

/** True when both are the same directory on disk, whatever they are called. One that is not there is not. */
function sameDirectory(one: string, other: string): boolean {
  try {
    return realpathSync.native(one) === realpathSync.native(other);
  } catch {
    return false;
  }
}

/** A host that says it ran in a directory that is not the project; one that does not say is not held to it. */
export function cwdProblem(run: HostRun, project: string): RunProblem | null {
  if (run.cwd === undefined || sameDirectory(run.cwd, project)) return null;
  return {
    reason: REASONS.cwdMismatch,
    detail: plainText(
      `the host ran in ${plainText(run.cwd, MAX_SHOWN_PATH_CHARS)} and not in the project of the check`,
    ),
  };
}

/** What stops a run after a request, besides what the marks already say. */
export const claimsProblem = (run: HostRun, project: string): RunProblem | null =>
  billingProblem(run) ?? cwdProblem(run, project);
