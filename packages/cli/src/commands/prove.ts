import { parseArgs } from 'node:util';
import { parseArgsProblem, usageError } from '../help.js';
import type { ProveDeps } from './prove-types.js';

export type { ProveDeps } from './prove-types.js';

/**
 * `stroq prove` - show, on the real host, that a denied action does not happen.
 *
 * Everything else says what Stroq would do. This drives the host (Claude Code, today) on three harmless
 * commands in a temporary folder, with Stroq's hook in the loop, and reads from places the model does not
 * write whether the one the policy denies was stopped, and whether the same command runs when the hook is
 * out of the way. It makes real requests on the owner's own login, so it says what it costs and asks first.
 *
 * This file holds the options and the parsing. The doing is loaded only when the command runs: the hook
 * process, which starts for every tool call, reads this module and nothing of what follows.
 */

/** The options of the command. Written out here, where `test/help.test.ts` reads them. */
export const PROVE_OPTIONS = {
  agent: { type: 'string', default: 'claude-code' },
  yes: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  'max-requests': { type: 'string' },
} as const;

/** The exit code of a command line that cannot be used (the other codes are `prove-report.ts`'s). */
const EXIT_USAGE = 2;

/** Requests a run makes unless told otherwise: the allow, the deny probe, and the control run of the deny. */
export const DEFAULT_MAX_REQUESTS = 3;
/** The most a run may be told to make: the five of a full check, and one more. */
export const MAX_REQUESTS_CEILING = 6;

export interface ProveOptions {
  readonly agent: string;
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly maxRequests: number;
}

type Parsed =
  | { readonly ok: true; readonly options: ProveOptions }
  | { readonly ok: false; readonly error: string };

/** A count of requests in digits, from 1 to the ceiling; null for anything else. */
function requestsOf(text: string | undefined): number | null {
  if (text === undefined) return DEFAULT_MAX_REQUESTS;
  if (!/^\d{1,3}$/.test(text)) return null;
  const count = Number(text);
  return count >= 1 && count <= MAX_REQUESTS_CEILING ? count : null;
}

function readValues(args: readonly string[]) {
  try {
    return { values: parseArgs({ args: [...args], options: PROVE_OPTIONS }).values };
  } catch (err) {
    const problem = parseArgsProblem(err);
    if (problem === null) throw err;
    return { problem };
  }
}

export function parseProveArgs(args: readonly string[]): Parsed {
  const read = readValues(args);
  if ('problem' in read) return { ok: false, error: read.problem };
  const { values } = read;
  const maxRequests = requestsOf(values['max-requests']);
  if (maxRequests === null)
    return {
      ok: false,
      error: `--max-requests has to be a whole number from 1 to ${MAX_REQUESTS_CEILING}`,
    };
  return {
    ok: true,
    options: {
      agent: values.agent ?? 'claude-code',
      yes: values.yes === true,
      dryRun: values['dry-run'] === true,
      json: values.json === true,
      maxRequests,
    },
  };
}

export async function runProve(args: readonly string[], deps: ProveDeps = {}): Promise<number> {
  const parsed = parseProveArgs(args);
  if (!parsed.ok) {
    (deps.err ?? ((text: string) => void process.stderr.write(text)))(
      usageError('prove', parsed.error),
    );
    return EXIT_USAGE;
  }
  const { proveFlow } = await import('./prove-flow.js');
  return proveFlow(parsed.options, deps);
}
