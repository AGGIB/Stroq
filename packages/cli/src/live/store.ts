// What `stroq prove` last found out about each host, kept under `<home>/live/`.
//
// `stroq doctor` reads this on every run, so the reader never throws and never returns part of a
// result: a file that is anything but exactly a result reads as "no result", with a few words on what
// is wrong that repeat nothing the file said. A test runs the reader in a child process, where a path
// that blocks costs a time limit and not a hung suite.
//
// Three files for an agent, and only the first is the result:
//
//   <agent>.json            the last live check that could say something: verified, or failed;
//   <agent>.last.json       a live check that could not (it hit a limit, the model refused, a stream
//                           could not be read), kept to look at and never shown as the host's state;
//   <agent>.stand-in.json   whatever a stand-in for a host said, which is about the stand-in.
//
// A check that could not tell must not wipe out one that could: a failure stays a failure, and a
// verification stays one, until a later check says otherwise. Only a live verified or a live failed
// replaces the result.
import { liveLastFileIn, liveResultFileIn, liveStandInFileIn } from '../paths.js';
import { readSmallRegularFile, writePrivateFileAtomic } from './private-file.js';
import { AGENT_NAME, parseHostResult, type HostResult } from './types.js';

/** A result is a few hundred bytes; a file of this size is not one. */
const MAX_RESULT_BYTES = 64 * 1024;

export interface StoredResult {
  readonly result: HostResult | null;
  /** Null when there is a result, and also when there is no file: nothing there is not a problem. */
  readonly problem: string | null;
}

/** Which of an agent's files a result is kept in: the result, or one of the two beside it. */
export type StoredSlot = 'live' | 'last' | 'stand-in';

const NONE: StoredResult = { result: null, problem: null };
const bad = (problem: string): StoredResult => ({ result: null, problem });

function readResultFile(file: string, agent: string): StoredResult {
  const read = readSmallRegularFile(file, MAX_RESULT_BYTES);
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

/** The result stored for `agent`, or why there is none. Never throws. */
export function readHostResult(home: string, agent: string): StoredResult {
  if (!AGENT_NAME.test(agent)) return bad('not an agent name');
  return readResultFile(liveResultFileIn(home, agent), agent);
}

/** What is kept beside the result of `agent`, to look at: read as strictly as the result. Never throws. */
export function readDiagnosticResult(
  home: string,
  agent: string,
  slot: 'last' | 'stand-in',
): StoredResult {
  if (!AGENT_NAME.test(agent)) return bad('not an agent name');
  const file = slot === 'last' ? liveLastFileIn(home, agent) : liveStandInFileIn(home, agent);
  return readResultFile(file, agent);
}

const slotOf = (result: HostResult): StoredSlot => {
  if (result.mode === 'stand-in') return 'stand-in';
  return result.state === 'verified' || result.state === 'failed' ? 'live' : 'last';
};

/**
 * Stores `result`, whole or not at all, in the file its mode and state call for, and says which. A
 * result that does not fit the format (or whose state does not follow from its probes) is not stored
 * (the reader would refuse it), and what was there stays. Throws when it cannot write.
 */
export function writeHostResult(home: string, result: HostResult): StoredSlot {
  // Through JSON and the same strict parse the reader uses, so that what is written is what is read.
  const checked = parseHostResult(JSON.parse(JSON.stringify(result)));
  if (!checked.ok) throw new Error(`refusing to store a result: ${checked.problem}`);
  const slot = slotOf(checked.result);
  const agent = checked.result.agent;
  const file =
    slot === 'stand-in'
      ? liveStandInFileIn(home, agent)
      : slot === 'last'
        ? liveLastFileIn(home, agent)
        : liveResultFileIn(home, agent);
  writePrivateFileAtomic(file, `${JSON.stringify(checked.result, null, 2)}\n`);
  return slot;
}
