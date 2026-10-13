import { parseArgs } from 'node:util';
import { formatActionsBench, runActionsBench } from '../bench/actions.js';
import { ACTION_SCENARIOS } from '../bench/actions-corpus.js';
import { formatLatencyBench, runLatencyBench } from '../bench/latency.js';
import { defaultCorpusDir, formatBench, runBench } from '../bench/run.js';
import { loadPolicy, policySource } from '../engine-factory.js';
import { displayPath } from './attack.js';

export async function runBenchCommand(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      corpus: { type: 'string' },
      actions: { type: 'boolean', default: false },
      latency: { type: 'boolean', default: false },
      n: { type: 'string', default: '100' },
      warmup: { type: 'string', default: '5' },
      json: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
    },
  });
  if (values.latency) {
    const n = Math.max(1, parseInt(values.n ?? '100', 10) || 100);
    const warmup = Math.max(0, parseInt(values.warmup ?? '5', 10) || 5);
    const report = await runLatencyBench({ n, warmup });
    process.stdout.write(
      values.json ? `${JSON.stringify(report, null, 2)}\n` : formatLatencyBench(report),
    );
    return 0;
  }
  if (values.actions) {
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
      'stroq bench: no corpus. The vendored corpus ships with the repository, not with the\n' +
        'npm package. Point the command at your own documentation instead:\n' +
        '  stroq bench --corpus <dir>\n',
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
