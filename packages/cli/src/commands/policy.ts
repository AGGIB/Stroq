import { parseArgs } from 'node:util';
import { runCheckCommand } from '../policy/check-command.js';
import { runTestCommand } from '../policy/test-command.js';
import { outsideLine } from '../ui/layout.js';

/**
 * `stroq policy`: see what an edit to your `policy.yaml` does before you rely on it.
 *
 *   stroq policy check [<file>] [--json]
 *   stroq policy test [--policy <file>] [--baseline default|<file>] [--cases <file>]
 *                     [--max-new-interruptions <n>] [--json]
 *
 * Both only read: they run no command, open no file but the ones named, send nothing anywhere and
 * write nothing, so they are open to an agent like `stroq attack` is (the state gate has no entry for
 * them, and `test/state-gate.test.ts` says so).
 *
 * Exit codes: 0 nothing needs attention, 1 findings (check) or a failed gate (test), 2 the command
 * line is wrong or an input cannot be read.
 */

const USAGE_ERROR = 2;

/** The options each subcommand has. `--json` is parsed with a default, so it is always present. */
const OPTIONS_OF: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['check', new Set(['json'])],
  ['test', new Set(['json', 'policy', 'baseline', 'cases', 'max-new-interruptions'])],
]);

function usageError(message: string): number {
  process.stderr.write(`stroq policy: ${message}\nRun "stroq policy --help" to see its options.\n`);
  return USAGE_ERROR;
}

export async function runPolicy(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      json: { type: 'boolean', default: false },
      policy: { type: 'string' },
      baseline: { type: 'string' },
      cases: { type: 'string' },
      'max-new-interruptions': { type: 'string' },
    },
    allowPositionals: true,
  });
  const [subcommand, ...rest] = positionals;
  if (subcommand === undefined) return usageError('needs a subcommand: check or test');
  const allowed = OPTIONS_OF.get(subcommand);
  if (allowed === undefined) {
    return usageError(`unknown subcommand "${outsideLine(subcommand)}": use check or test`);
  }
  const given = Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name);
  const stray = given.find((name) => !allowed.has(name));
  if (stray !== undefined) return usageError(`--${stray} is not an option of "${subcommand}"`);
  if (subcommand === 'check') {
    if (rest.length > 1) return usageError('check takes one file at most');
    return runCheckCommand(rest[0], values.json === true);
  }
  if (rest.length > 0)
    return usageError('test takes no file; name the policy with --policy <file>');
  return runTestCommand({
    policy: values.policy,
    baseline: values.baseline,
    cases: values.cases,
    maxNewInterruptions: values['max-new-interruptions'],
    json: values.json === true,
  });
}
