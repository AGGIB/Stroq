// Whether a host's answer to one request can be used at all.
//
// A run that went wrong proves nothing either way, so it is never a pass and never a failure: it ran
// into a limit, nobody was logged in, it was billed to somewhere it must not be, it was cut off, it ended
// with an error, or what it wrote cannot be read. The checks are made on what the driver handed over,
// and a driver is code that talks to a program we do not control, so a shape that is not a `HostRun` is a
// run that cannot be read, and not a reason to throw after a request has been paid for.
import { authTextOf, limitTextOf } from './limit-text.js';
import { plainText } from './plain-text.js';
import { REASONS, type HostRun, type StreamEvent } from './types.js';

/**
 * What a host reports as the way it is paid for, when it is a login and no key. Anything else is a key
 * that bills an account other than the subscription, and this check never spends that.
 */
const SUBSCRIPTION_KEY_SOURCES: ReadonlySet<string> = new Set(['none', 'oauth']);

const EVENT_TYPES: ReadonlySet<string> = new Set([
  'init',
  'tool_use',
  'tool_result',
  'text',
  'result',
  'other',
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isOptional = (value: unknown, type: 'string' | 'boolean'): boolean =>
  value === undefined || typeof value === type;

/** True for one event of the stream as `StreamEvent` describes it. */
export function isEvent(value: unknown): value is StreamEvent {
  return (
    isObject(value) &&
    typeof value['type'] === 'string' &&
    EVENT_TYPES.has(value['type']) &&
    isOptional(value['name'], 'string') &&
    isOptional(value['text'], 'string') &&
    isOptional(value['isError'], 'boolean')
  );
}

/** True when `run` has the shape of a `HostRun`: events that are events, and fields of the right kind. */
export function isWellFormedRun(run: unknown): run is HostRun {
  if (!isObject(run)) return false;
  return (
    Array.isArray(run['stream']) &&
    run['stream'].every(isEvent) &&
    (run['exitCode'] === null || typeof run['exitCode'] === 'number') &&
    typeof run['timedOut'] === 'boolean' &&
    typeof run['stderrTail'] === 'string' &&
    isOptional(run['limitHit'], 'string') &&
    isOptional(run['apiProvider'], 'string') &&
    isOptional(run['apiKeySource'], 'string') &&
    (run['unparsedLines'] === undefined ||
      (typeof run['unparsedLines'] === 'number' && Number.isFinite(run['unparsedLines'])))
  );
}

/** The events of a run that are events. A run that is not well formed has fewer than it was given. */
export const eventsOf = (run: HostRun): readonly StreamEvent[] =>
  Array.isArray(run?.stream) ? run.stream.filter(isEvent) : [];

export interface RunProblem {
  readonly reason: string;
  readonly detail: string;
}

const problem = (reason: string, detail: string): RunProblem => ({
  reason,
  detail: plainText(detail),
});

/**
 * Whether the run itself went wrong, apart from what it did. Such a run proves nothing either way: a run
 * that was cut off is one whose disk is still changing, and a stream that cannot be read is one in which
 * the model's part is not known.
 *
 * Only the host's own error words are read for a limit or a login (stderr, and a final result marked
 * as an error). What the model said and what a command printed are not the host's word.
 */
export function runProblem(run: HostRun): RunProblem | null {
  if (!isWellFormedRun(run))
    return problem(
      REASONS.unparsableStream,
      'the answer of the host is not in a shape that can be read',
    );
  if (run.limitHit !== undefined) return problem(REASONS.limit, `the host said: ${run.limitHit}`);
  if (run.apiProvider !== undefined && run.apiProvider !== 'firstParty')
    return problem(REASONS.apiBilling, `the host is not first party (${run.apiProvider})`);
  if (
    run.apiKeySource !== undefined &&
    !SUBSCRIPTION_KEY_SOURCES.has(run.apiKeySource.trim().toLowerCase())
  )
    return problem(REASONS.apiBilling, `the host used an API key (${run.apiKeySource})`);
  const errors = run.stream.filter((e) => e.type === 'result' && e.isError === true);
  const words = [run.stderrTail, ...errors.map((e) => e.text ?? '')];
  for (const text of words) {
    const limit = limitTextOf(text);
    if (limit !== null) return problem(REASONS.limit, `the host said: ${limit}`);
  }
  for (const text of words) {
    const auth = authTextOf(text);
    if (auth !== null) return problem(REASONS.auth, `the host said: ${auth}`);
  }
  if (run.timedOut) return problem(REASONS.timeout, 'the host did not answer in time');
  if (run.exitCode !== 0)
    return problem(
      REASONS.hostError,
      run.exitCode === null
        ? 'the host did not run to the end'
        : `the host exited with code ${run.exitCode}`,
    );
  if (errors.length > 0) return problem(REASONS.hostError, 'the host ended with an error');
  if (!run.stream.some((e) => e.type === 'result'))
    return problem(REASONS.unparsableStream, 'no final result could be read from the stream');
  return null;
}
