// What `verifyHost` is handed, looked at before anything is asked, spent or written.
//
// The options come from a command line and the driver from code that talks to a program we do not
// control, so none of it is taken as given. A value that cannot be right is refused with an error that has
// a code (`invalid-option`), at the door, and not found out later as a throw in the middle of a run that
// has already taken requests from the owner's ledger.
import type { Ledger } from './budget.js';
import { LiveCheckError } from './errors.js';
import { plainText } from './plain-text.js';
import { AGENT_NAME, type HostDriver, type ProbeContext } from './types.js';

/** The most a timer can count: past it, Node makes the wait one millisecond long. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** How long a driver is given to say whether its host is there. */
export const DEFAULT_DETECT_MS = 10_000;

/** The same line a result can hold for a version. */
const VERSION_TEXT = /^[\x20-\x7e]{1,80}$/;
const MAX_VERSION_CHARS = 80;

/**
 * What the driver called the host's version, as the line of plain characters a result keeps; null when it
 * said nothing. Whoever compares a stored version with the host's today makes the same line of that.
 */
export const hostVersionText = (version: string | null): string | null => {
  const text = version === null ? '' : plainText(version, MAX_VERSION_CHARS);
  return text === '' ? null : text;
};

/** What `verifyHost` looks at in its options, which is all of them. */
export interface CheckableOptions {
  readonly agent: string;
  readonly stroqVersion: string;
  readonly ledger: Ledger;
  readonly policy: unknown;
  readonly maxRequests?: number | undefined;
  readonly graceMs?: number | undefined;
  readonly detectMs?: number | undefined;
  readonly mode?: 'live' | 'stand-in' | undefined;
}

const invalid = (option: string, wanted: string): LiveCheckError =>
  new LiveCheckError('invalid-option', `${option} ${wanted}`);

const isWhole = (value: unknown, least: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= least;

/**
 * Throws `LiveCheckError('invalid-option')`, naming the option, for anything `verifyHost` cannot work
 * with. Looks at all of it before returning, so that nothing is asked of a host on a run that was never
 * going to be right.
 */
export function checkInputs(
  base: Pick<ProbeContext, 'deadlineMs'>,
  options: CheckableOptions,
): void {
  if (typeof options.agent !== 'string' || !AGENT_NAME.test(options.agent))
    throw invalid('agent', 'is not an agent name');
  if (typeof options.stroqVersion !== 'string' || !VERSION_TEXT.test(options.stroqVersion))
    throw invalid('stroqVersion', 'has to be one line of plain characters, up to 80 of them');
  if (options.maxRequests !== undefined && !isWhole(options.maxRequests, 0))
    throw invalid('maxRequests', 'has to be a whole number, 0 or more');
  if (!isWhole(base.deadlineMs, 1))
    throw invalid('deadlineMs', 'has to be a whole number of at least 1');
  if (options.graceMs !== undefined && !isWhole(options.graceMs, 0))
    throw invalid('graceMs', 'has to be a whole number, 0 or more');
  if (options.detectMs !== undefined && !isWhole(options.detectMs, 1))
    throw invalid('detectMs', 'has to be a whole number of at least 1');
  if (base.deadlineMs + (options.graceMs ?? 0) > MAX_TIMER_MS)
    throw invalid('deadlineMs and graceMs', 'together are more than a timer can count');
  if (options.mode !== undefined && options.mode !== 'live' && options.mode !== 'stand-in')
    throw invalid('mode', "has to be 'live' or 'stand-in'");
  if (typeof options.ledger?.take !== 'function' || typeof options.ledger?.peek !== 'function')
    throw invalid('ledger', 'has to be a ledger that can count requests');
  const policy = options.policy as { rules?: unknown } | null | undefined;
  if (typeof policy !== 'object' || policy === null || !Array.isArray(policy.rules))
    throw invalid('policy', 'has to be a policy');
}

/**
 * The names of the variables that make a host bill an API key or another cloud, and so spend what the
 * owner did not set aside: `ANTHROPIC_*` (the key, the token, the endpoint) and `CLAUDE_CODE_USE_*`
 * (Bedrock, Vertex, Foundry), and for the other host of the table that can be driven, `OPENAI_*` and
 * `CODEX_API_KEY` (its login is a file, not a variable, so a variable can only be a key). Whatever case
 * they are in: on Windows a variable has no case. (When a host gets a driver of its own, the variables
 * that are its own belong to its row of the table; the families above are the ones known today.)
 */
const BILLING_VARIABLE = /^(ANTHROPIC_|CLAUDE_CODE_USE_|OPENAI_|CODEX_API_KEY$)/i;

/**
 * The environment a driver is handed: a copy, without any variable that would bill the run to an API
 * key, and without a value that is not text (a child process cannot be given one). The caller's own
 * environment is left as it was.
 */
export function scrubbedEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const kept: Record<string, string> = {};
  if (typeof env !== 'object' || env === null) return kept;
  for (const [name, value] of Object.entries(env))
    if (typeof value === 'string' && !BILLING_VARIABLE.test(name)) kept[name] = value;
  return kept;
}

/** What the driver said when it was asked for its host, made safe to use. */
export interface Detected {
  readonly available: boolean;
  readonly version: string | null;
  readonly note?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** The answer of `detect`, in the shape it should have: anything else is a host that is not there. */
function cleanDetected(answer: unknown): Detected {
  if (!isObject(answer) || typeof answer['available'] !== 'boolean')
    return {
      available: false,
      version: null,
      note: 'the driver did not say whether the host is there',
    };
  const note = typeof answer['note'] === 'string' ? plainText(answer['note']) : '';
  return {
    available: answer['available'],
    version: typeof answer['version'] === 'string' ? answer['version'] : null,
    ...(note === '' ? {} : { note }),
  };
}

/**
 * Asks the driver whether its host is there, and does not wait for ever for the answer: a driver that
 * throws, rejects, does not answer in `timeoutMs`, or answers with something that is not an answer is a
 * host that is not there, with the reason. A blank note is no note.
 */
export async function lookForHost(driver: HostDriver, timeoutMs: number): Promise<Detected> {
  let timer: NodeJS.Timeout | undefined;
  const silent = new Promise<Detected>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          available: false,
          version: null,
          note: 'the driver did not answer when it was asked for the host',
        }),
      timeoutMs,
    );
    timer.unref();
  });
  const asked = Promise.resolve()
    .then(() => driver.detect())
    .then(cleanDetected)
    .catch((): Detected => ({
      available: false,
      version: null,
      note: 'the driver could not look for the host',
    }));
  try {
    return await Promise.race([asked, silent]);
  } finally {
    clearTimeout(timer);
  }
}
