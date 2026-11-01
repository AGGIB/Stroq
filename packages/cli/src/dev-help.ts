// The usage of the three developer tools that used to be commands: `pnpm dev:prove`, `pnpm dev:bench` and
// `pnpm dev:coverage` (scripts/dev/). They are not in `stroq --help`, and `stroq prove`, `stroq bench` and
// `stroq coverage` print where they went (removed-commands.ts). The flags they take are written down
// here, in the same shape as `COMMANDS`, so that `test/help.test.ts` still holds each tool's help to the
// flags its source parses, and the docs that copy a sentence of it are still held to the code.

import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseArgsProblem,
  renderHelp,
  unknownOptionOf,
  wantsHelpOf,
  type CommandHelp,
} from './help.js';
import { withSafeOutput } from './terminal-safe.js';

export const DEV_COMMANDS: readonly CommandHelp[] = [
  {
    name: 'prove',
    synopsis: 'prove [--agent <id>] [--yes] [--dry-run] [--json] [--max-requests <n>]',
    about: [
      'check that blocking really works on this machine. Your agent runs 3 harmless',
      'commands with the hook in place. Stroq checks that the ones your policy blocks did',
      'not run, and that they do run with the hook out of the way. It checks the files the',
      "commands leave and its own log, not the agent's reply.",
      'It makes up to 3 short requests on your own login (your subscription, never an API',
      'key). It says so and asks first. Exit 0: it works. 1: it failed. 3: anything else.',
    ],
    flags: [
      [
        '--agent <id>',
        'claude-code (default, macOS/Linux) or codex (Windows, measured CLI 0.162.1 only)',
      ],
      ['--yes', 'make the requests without asking; needed where there is no terminal to ask on'],
      ['--dry-run', 'say what would be done, make no request and write nothing'],
      ['--json', 'machine-readable output (version 1)'],
      ['--max-requests <n>', 'the most requests to make, 1 to 6 (default 3)'],
    ],
  },
  {
    name: 'bench',
    synopsis:
      'bench [--corpus <dir> | --actions | --latency] [--n <count>] [--warmup <count>] [--json] [--verbose]',
    about: [
      'measure how much benign developer text the rule set flags,',
      '(--actions) how much ordinary agent work your policy interrupts,',
      'or (--latency) what a hook call costs in processor and wall time (p50/p95/p99)',
    ],
    flags: [
      ['--corpus <dir>', 'measure your own files instead of the shipped corpus'],
      ['--actions', 'replay 75 scenarios of ordinary agent work against your policy'],
      ['--latency', 'measure hook invocation processor and wall time on claude-code'],
      ['--n <count>', 'number of measured runs per event (default 100)'],
      ['--warmup <count>', 'number of warmup runs per event (default 5)'],
      ['--json', 'machine-readable output'],
      ['--verbose', 'list the flagged files'],
    ],
  },
  {
    name: 'coverage',
    synopsis: 'coverage [--format table|navigator] [--json]',
    about: ['the control mapping against MITRE ATLAS and OWASP ASI'],
    flags: [
      ['--format <table|navigator>', 'navigator emits an ATT&CK Navigator layer'],
      ['--json', 'machine-readable output'],
    ],
  },
];

const byName = new Map(DEV_COMMANDS.map((c) => [c.name, c]));

/** The tool called `name` (`prove`, `bench` or `coverage`), or undefined. */
export const devCommand = (name: string): CommandHelp | undefined => byName.get(name);

/** What `pnpm dev:<name> -- --help` prints. */
export function devHelp(name: string): string | null {
  const c = byName.get(name);
  return c === undefined ? null : renderHelp(c, 'pnpm dev:');
}

/** The exit code of a command line that cannot be used, as for the commands of the CLI. */
const EXIT_USAGE = 2;

/** What a usage error of a developer tool prints, from the tool and what was wrong with it. */
export function devUsageError(name: string, problem: string): string {
  return `pnpm dev:${name}: ${problem}\nRun "pnpm dev:${name} -- --help" to see its options.\n`;
}

/**
 * Runs one of the developer tools as `stroq <command>` ran it: `--help`, an option the tool does not
 * have and an argument `parseArgs` refuses are answered here, and the output goes through the same
 * filter as the commands of the CLI, because what these print includes file names from a corpus and the
 * words of a host. A leading `--` is the one `pnpm dev:bench -- --actions` may pass on, and is dropped.
 */
export async function runDevTool(
  name: string,
  args: readonly string[],
  run: (args: readonly string[]) => number | Promise<number>,
): Promise<number> {
  const tool = byName.get(name);
  if (tool === undefined) throw new Error(`no developer tool called "${name}"`);
  const own = args[0] === '--' ? args.slice(1) : args;
  if (wantsHelpOf(tool, own)) {
    process.stdout.write(renderHelp(tool, 'pnpm dev:'));
    return 0;
  }
  const unknown = unknownOptionOf(tool, own);
  if (unknown !== null) {
    process.stderr.write(devUsageError(name, `unknown option ${unknown}`));
    return EXIT_USAGE;
  }
  return withSafeOutput(async () => {
    try {
      return await run(own);
    } catch (err) {
      const problem = parseArgsProblem(err);
      if (problem === null) throw err;
      process.stderr.write(devUsageError(name, problem));
      return EXIT_USAGE;
    }
  });
}

/**
 * The built CLI, `packages/cli/dist/index.js`: the file a hook line starts. The developer tools run from
 * source (`scripts/dev/*.ts`), so `process.argv[1]` is the tool and not the Stroq that a host is to call;
 * `dev:bench --latency` and `dev:prove` both need the real one, and say so when it has not been built.
 */
export function builtCliEntry(): string {
  const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  if (!existsSync(entry)) {
    throw new Error('CLI bundle not found. Please build the packages with "pnpm build" first.');
  }
  return realpathSync(entry);
}
