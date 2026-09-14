import { parseArgs } from 'node:util';
import { defaultCorpusDir, formatBench, runBench } from '../bench/run.js';

export async function runBenchCommand(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      corpus: { type: 'string' },
      json: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
    },
  });
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
      : formatBench(report, { verbose: values.verbose }),
  );
  return 0;
}
