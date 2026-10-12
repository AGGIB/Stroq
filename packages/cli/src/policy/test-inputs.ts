import { DEFAULT_POLICY, type Policy } from '@stroq/core';
import { displayPath } from '../commands/attack.js';
import { quotePath } from '../install/safe-path.js';
import { policyFile } from '../paths.js';
import { outsideLine } from '../ui/layout.js';
import { faultsOf, type Loaded } from './check.js';
import { fixForCaseField } from './fault-hints.js';
import {
  MAX_CASES,
  MAX_CASES_BYTES,
  readCasesFile,
  type CasesRead,
  type UserCase,
} from './cases.js';
import { MAX_POLICY_BYTES, readPolicyFile } from './load.js';
import { describeUnreadable } from './read-text.js';

/**
 * The three inputs of `stroq policy test`, each read the way `stroq policy check` reads a policy:
 * bounded, on one handle, and with every fault told as the path of a field and a fixed phrase.
 * A result is either the thing, or the lines to print on standard error before exiting 2.
 */

const COMMAND = 'stroq policy test';

/** At most this many faults are told; the file has to be corrected, and the first ones are the way in. */
const MAX_FAULT_LINES = 10;

export type Input<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly lines: readonly string[] };

/** One of the two policies a run compares. */
export interface Side {
  readonly policy: Policy;
  /** `default` or the path as the person wrote it, shortened under the home folder. */
  readonly source: string;
}

const refuse = (...lines: readonly string[]): Input<never> => ({ ok: false, lines });

const BUILT_IN: Side = { policy: DEFAULT_POLICY, source: 'default' };

function policyProblem(shown: string, read: Exclude<Loaded, { readonly ok: true }>): Input<never> {
  const faults = faultsOf(read);
  const listed = faults.slice(0, MAX_FAULT_LINES).map((fault) => `  ${fault.message}`);
  const more = faults.length - listed.length;
  return refuse(
    `${COMMAND}: ${shown} is not a policy Stroq can load, so there is nothing to test:`,
    ...listed,
    ...(more > 0 ? [`  and ${more} more`] : []),
    'Run stroq policy check on that file for what to change.',
  );
}

/**
 * A policy named by a path. `fallbackToBuiltIn` is for the one case the hook has too: the policy in
 * force, when there is no policy.yaml, is the built-in one.
 */
function loadPolicy(path: string, flag: string, fallbackToBuiltIn: boolean): Input<Side> {
  const shown = outsideLine(displayPath(path));
  const read = readPolicyFile(path);
  if (read.ok) return { ok: true, value: { policy: read.policy, source: displayPath(path) } };
  if (read.problem !== 'unreadable') return policyProblem(shown, read);
  if (fallbackToBuiltIn && read.why === 'missing') return { ok: true, value: BUILT_IN };
  return refuse(`${COMMAND}: ${flag}${shown}: ${describeUnreadable(read.why, MAX_POLICY_BYTES)}`);
}

/** The candidate: `--policy <file>`, or the policy in force. */
export function loadCandidate(file: string | undefined): Input<Side> {
  return file === undefined
    ? loadPolicy(policyFile(), '', true)
    : loadPolicy(file, '--policy ', false);
}

/** The baseline: `default` (the built-in policy, and what no flag means), or `--baseline <file>`. */
export function loadBaseline(value: string | undefined): Input<Side> {
  return value === undefined || value === 'default'
    ? { ok: true, value: BUILT_IN }
    : loadPolicy(value, '--baseline ', false);
}

function casesProblem(
  shown: string,
  read: Exclude<CasesRead, { readonly ok: true }>,
): Input<never> {
  const head = `${COMMAND}: --cases ${shown}`;
  switch (read.problem) {
    case 'unreadable':
      return refuse(`${head}: ${describeUnreadable(read.why, MAX_CASES_BYTES)}`);
    case 'yaml':
      return refuse(
        `${head}: ${read.fault.what}${read.fault.line === null ? '' : ` (line ${read.fault.line})`}`,
      );
    case 'too-many':
      return refuse(`${head}: has ${read.count} cases, and at most ${MAX_CASES} are taken`);
    case 'schema': {
      const listed = read.faults
        .slice(0, MAX_FAULT_LINES)
        .map(
          (fault) =>
            `  ${fault.path === '' ? 'the file' : quotePath(fault.path)}: ${fault.kind} (${fixForCaseField(fault.path)})`,
        );
      const more = read.faults.length - listed.length;
      return refuse(
        `${head}: is not a file of cases Stroq can read:`,
        ...listed,
        ...(more > 0 ? [`  and ${more} more`] : []),
      );
    }
  }
}

/** The person's own cases, or nothing when no file was named. */
export function loadCases(file: string | undefined): Input<readonly UserCase[]> {
  if (file === undefined) return { ok: true, value: [] };
  const read = readCasesFile(file);
  if (read.ok) return { ok: true, value: read.cases };
  return casesProblem(outsideLine(displayPath(file)), read);
}
