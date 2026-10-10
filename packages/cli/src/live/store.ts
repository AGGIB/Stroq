// What `stroq prove` last found out about each host, kept at `<home>/live/<agent>.json`.
//
// `stroq doctor` reads this on every run, so the reader never throws and never returns part of a
// result: a file that is anything but exactly a result reads as "no result", with a few words on what
// is wrong that repeat nothing the file said. A test runs the reader in a child process, where a path
// that blocks costs a time limit and not a hung suite.
import { liveResultFileIn } from '../paths.js';
import { readSmallRegularFile, writePrivateFileAtomic } from './private-file.js';
import { AGENT_NAME, parseHostResult, type HostResult } from './types.js';

/** A result is a few hundred bytes; a file of this size is not one. */
const MAX_RESULT_BYTES = 64 * 1024;

export interface StoredResult {
  readonly result: HostResult | null;
  /** Null when there is a result, and also when there is no file: nothing there is not a problem. */
  readonly problem: string | null;
}

const NONE: StoredResult = { result: null, problem: null };
const bad = (problem: string): StoredResult => ({ result: null, problem });

/** The result stored for `agent`, or why there is none. Never throws. */
export function readHostResult(home: string, agent: string): StoredResult {
  if (!AGENT_NAME.test(agent)) return bad('not an agent name');
  const read = readSmallRegularFile(liveResultFileIn(home, agent), MAX_RESULT_BYTES);
  if (read.kind === 'absent') return NONE;
  if (read.kind === 'refused')
    return bad(read.why === 'too large' ? 'larger than 64 KiB' : read.why);
  let json: unknown;
  try {
    json = JSON.parse(read.text);
  } catch {
    return bad('not JSON');
  }
  const parsed = parseHostResult(json);
  if (!parsed.ok) return bad(parsed.problem);
  // A file moved into place by hand is a claim about whichever agent its author had in mind.
  if (parsed.result.agent !== agent) return bad('belongs to another agent');
  return { result: parsed.result, problem: null };
}

/**
 * Stores `result` as the one for its agent, whole or not at all. A result that does not fit the format
 * is not stored (the reader would refuse it), and the previous one stays. Throws when it cannot write.
 */
export function writeHostResult(home: string, result: HostResult): void {
  // Through JSON and the same strict parse the reader uses, so that what is written is what is read.
  const checked = parseHostResult(JSON.parse(JSON.stringify(result)));
  if (!checked.ok) throw new Error(`refusing to store a result that ${checked.problem}`);
  writePrivateFileAtomic(
    liveResultFileIn(home, checked.result.agent),
    `${JSON.stringify(checked.result, null, 2)}\n`,
  );
}
