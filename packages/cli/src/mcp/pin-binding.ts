// What a runtime pin holds besides the name of the server and the digest of its files.
//
// `add` records, beside the pin, the entry it wrote into the client config (`written`): the command and every
// argument in order, which is the Stroq entry, `mcp`, `--server`, `--client`, `--pin`, `--cwd`, `--pass-env`,
// and the command after `--`. A wrapper is a file an agent can edit, and the name and the digest alone would
// let an edit give the confirmed server a secret (`--pass-env`), run another file of the confirmed tree, add
// arguments, drop `--cloak`, or start a different Stroq, while `doctor` stayed green.
//
// So when the record has `written`, the command line the proxy was started with is compared with it token by
// token (the same tokens in the same order, nothing added, nothing taken out), and `doctor`, which can see the
// whole config entry, compares that too (`env`, `cwd`, any other key). Any difference is a refusal. The
// comparison is on the lock's `written`, never on the client config, and the refusals are fixed phrases that
// hold nothing of the wrapper. A record without `written` (one written by hand) is held to what it has.
import { isDeepStrictEqual } from 'node:util';
import { BIND_PHRASES } from './pin-argument.js';

/** A wrapper that is not the one that was confirmed. The message is a fixed phrase, safe to print. */
export class PinBindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PinBindError';
  }
}

export interface WrapperAsRun {
  /** The names the wrapper passes, or null when it has no `--pass-env` (and so inherits everything). */
  readonly passEnv?: readonly string[] | null;
}

/** The command line the client starts, whole: the program, then every argument, node's own flags included. */
export interface Launch {
  readonly command: string;
  readonly argv: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** The same names, with the same repeats; the order is the business of the whole-line comparison. */
const sameMultiset = (a: readonly string[], b: readonly string[]): boolean => {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((name, i) => name === right[i]);
};

export interface Comparison {
  /** The command line the wrapper was started with; without it a recorded entry cannot be compared. */
  readonly launch?: Launch;
  /** The config entry as it stands, for a caller that can see the client config (`doctor`). */
  readonly entry?: unknown;
}

/**
 * Throws a `PinBindError` unless the wrapper agrees with what `add` recorded. `startFile` is the path in the
 * tree of the first argument, which the pin has already shown to be a file of the confirmed tree.
 */
export function assertBound(
  record: unknown,
  wrapper: WrapperAsRun,
  startFile: string,
  comparison: Comparison = {},
): void {
  if (!isRecord(record)) return;
  const names = record['passEnv'];
  if (isStrings(names) && (wrapper.passEnv == null || !sameMultiset(wrapper.passEnv, names)))
    throw new PinBindError(BIND_PHRASES[0]);
  const entry = record['entrypoint'];
  if (typeof entry === 'string' && entry !== startFile) throw new PinBindError(BIND_PHRASES[1]);
  const written = record['written'];
  if (!isRecord(written)) return;
  const { launch } = comparison;
  if (launch === undefined) throw new PinBindError(BIND_PHRASES[4]);
  const args = written['args'];
  const same =
    written['command'] === launch.command &&
    isStrings(args) &&
    args.length === launch.argv.length &&
    args.every((arg, i) => arg === launch.argv[i]);
  if (!same) throw new PinBindError(BIND_PHRASES[2]);
  if (comparison.entry !== undefined && !isDeepStrictEqual(comparison.entry, written))
    throw new PinBindError(BIND_PHRASES[3]);
}
