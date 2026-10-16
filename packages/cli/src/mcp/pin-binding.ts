// What a runtime pin holds besides the name of the server and the digest of its files.
//
// `add` records, beside the pin, what it wrote into the client config: the variables the wrapper passes,
// the start file, and the command that follows `--`. A wrapper is a file an agent can edit, and the name and
// the digest alone would let an edit give the confirmed server a secret (`--pass-env`), run another file of
// the confirmed tree, or add arguments, while `doctor` stayed green. So when the record has these fields the
// wrapper in front of the proxy must agree with them, and the proxy refuses to start otherwise, with a
// fixed phrase that `doctor` shows. A record without them (one written by hand) is held to what it has.
import { wrapperIndex } from '../commands/mcp-config.js';
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
  readonly command: string;
  readonly args: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const sameNames = (a: readonly string[], b: readonly string[]): boolean => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((name) => right.has(name));
};

/** The command and arguments that the recorded wrapper entry gives the server, after its `--`. */
function recordedCommand(written: unknown): string[] | null {
  const args = isRecord(written) ? written['args'] : undefined;
  if (!isStrings(args)) return null;
  const at = wrapperIndex(args) ?? args.indexOf('mcp');
  const end = args.indexOf('--', Math.max(at, 0));
  return end === -1 ? null : args.slice(end + 1);
}

/**
 * Throws a `PinBindError` unless the wrapper agrees with what `add` recorded. `startFile` is the path in the
 * tree of the first argument, which the pin has already shown to be a file of the confirmed tree.
 */
export function assertBound(record: unknown, wrapper: WrapperAsRun, startFile: string): void {
  if (!isRecord(record)) return;
  const names = record['passEnv'];
  if (isStrings(names) && (wrapper.passEnv == null || !sameNames(wrapper.passEnv, names)))
    throw new PinBindError(BIND_PHRASES[0]);
  const entry = record['entrypoint'];
  if (typeof entry === 'string' && entry !== startFile) throw new PinBindError(BIND_PHRASES[1]);
  const recorded = recordedCommand(record['written']);
  const now = [wrapper.command, ...wrapper.args];
  if (
    recorded !== null &&
    (recorded.length !== now.length || recorded.some((x, i) => x !== now[i]))
  )
    throw new PinBindError(BIND_PHRASES[2]);
}
