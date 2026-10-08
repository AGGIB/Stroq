import { parseArgs } from 'node:util';
import { formatActionsBench, runActionsBench } from '../bench/actions.js';
import { ACTION_SCENARIOS } from '../bench/actions-corpus.js';
import { defaultCorpusDir, formatBench, runBench } from '../bench/run.js';
import { loadPolicy, policySource } from '../engine-factory.js';
import { displayPath } from './attack.js';

export async function runBenchCommand(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      corpus: { type: 'string' },
      actions: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
    },
  });
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
    return 0;
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
