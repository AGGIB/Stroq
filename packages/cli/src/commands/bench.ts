import { parseArgs } from 'node:util';
import { formatActionsBench, runActionsBench } from '../bench/actions.js';
import { ACTION_SCENARIOS } from '../bench/actions-corpus.js';
import { formatLatencyBench, runLatencyBench } from '../bench/latency.js';
import { defaultCorpusDir, formatBench, runBench } from '../bench/run.js';
import { loadPolicy, policySource } from '../engine-factory.js';
import { devUsageError } from '../dev-help.js';
import { parseArgsProblem } from '../help.js';
import { displayPath } from './attack.js';

const EXIT_USAGE = 2;

export const BENCH_OPTIONS = {
  corpus: { type: 'string' },
  actions: { type: 'boolean', default: false },
  latency: { type: 'boolean', default: false },
  n: { type: 'string' },
  warmup: { type: 'string' },
  json: { type: 'boolean', default: false },
  verbose: { type: 'boolean', default: false },
} as const;

function parseBoundInteger(
  val: string | undefined,
  flagName: string,
  min: number,
  max: number,
  defaultValue: number,
): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: string } {
  if (val === undefined) return { ok: true, value: defaultValue };
  if (!/^\d+$/.test(val)) {
    return { ok: false, error: `${flagName} has to be a whole number from ${min} to ${max}` };
  }
  const num = Number(val);
  if (num < min || num > max) {
    return { ok: false, error: `${flagName} has to be a whole number from ${min} to ${max}` };
  }
  return { ok: true, value: num };
}

export async function runBenchCommand(args: readonly string[]): Promise<number> {
  let values;
  try {
    values = parseArgs({
      args: [...args],
      options: BENCH_OPTIONS,
    }).values;
  } catch (err) {
    const problem = parseArgsProblem(err);
    if (problem === null) throw err;
    process.stderr.write(devUsageError('bench', problem));
    return EXIT_USAGE;
  }

  if (values.latency) {
    if (values.actions || values.corpus !== undefined) {
      process.stderr.write(
        devUsageError('bench', '--latency cannot be combined with --actions or --corpus'),
      );
      return EXIT_USAGE;
    }
    const parsedN = parseBoundInteger(values.n, '--n', 1, 1000, 100);
    if (!parsedN.ok) {
      process.stderr.write(devUsageError('bench', parsedN.error));
      return EXIT_USAGE;
    }
    const parsedWarmup = parseBoundInteger(values.warmup, '--warmup', 0, 100, 5);
    if (!parsedWarmup.ok) {
      process.stderr.write(devUsageError('bench', parsedWarmup.error));
      return EXIT_USAGE;
    }
    try {
      const report = await runLatencyBench({ n: parsedN.value, warmup: parsedWarmup.value });
      process.stdout.write(
        values.json ? `${JSON.stringify(report, null, 2)}\n` : formatLatencyBench(report),
      );
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pnpm dev:bench: ${msg}\n`);
      return 1;
    }
  }

  if (values.n !== undefined || values.warmup !== undefined) {
    process.stderr.write(devUsageError('bench', '--n and --warmup are only valid with --latency'));
    return EXIT_USAGE;
  }

  if (values.actions) {
    if (values.corpus !== undefined) {
      process.stderr.write(devUsageError('bench', '--actions cannot be combined with --corpus'));
      return EXIT_USAGE;
    }
    // The other side of `stroq attack`: ordinary work, and how often it is interrupted.
    const report = await runActionsBench(
      ACTION_SCENARIOS,
      loadPolicy(),
      displayPath(policySource()),
    );
    process.stdout.write(
      values.json ? `${JSON.stringify(report, null, 2)}\n` : formatActionsBench(report),
    );
    // A rate that could not be measured (a timeout, an error) is not a rate that passed.
    return report.ok ? 0 : 1;
  }

  const dir = values.corpus ?? defaultCorpusDir();
  if (dir === null) {
    process.stderr.write(
      'pnpm dev:bench: no corpus. The vendored corpus is fetched into the repository\n' +
        '(pnpm fetch:bench-corpus), not shipped in the npm package. Point the tool at\n' +
        'your own documentation instead:\n' +
        '  pnpm dev:bench -- --corpus <dir>\n',
    );
    return 1;
  }
  const report = runBench(dir);
  process.stdout.write(
    values.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatBench(report, { verbose: values.verbose, timings: true }),
  );
  return 0;
}
