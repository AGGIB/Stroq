import { expect, it } from 'vitest';
import { formatBench, type BenchReport } from '../../src/bench/run.js';

it('renders benchmark paths identically for Windows and POSIX report generation', () => {
  const report: BenchReport = {
    version: 1,
    corpus: 'vendor/bench-corpus/files',
    files: 1,
    bytes: 42,
    rules: 1,
    flagged: 1,
    rate: 1,
    timedOut: 0,
    slowestMs: 1,
    slowestFile: 'vendor/bench-corpus/files/example/README.md',
    byRule: [],
    flaggedFiles: ['vendor/bench-corpus/files/example/README.md'],
  };
  const windows = {
    ...report,
    corpus: report.corpus.replaceAll('/', '\\'),
    flaggedFiles: report.flaggedFiles.map((path) => path.replaceAll('/', '\\')),
  };
  expect(formatBench(windows, { verbose: true })).toBe(formatBench(report, { verbose: true }));
});
