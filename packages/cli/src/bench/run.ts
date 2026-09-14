import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBundledRules, scanContent } from '@stroq/core';

/** Text extensions only: the corpus is documentation, and a binary would measure nothing. */
const TEXT = /\.(?:md|rst|txt|adoc)$/i;
/**
 * The most of a file `runBench` will ever read, comfortably above `scanContent`'s own
 * 200,000-character scan window for any realistic text. Production never skips large
 * input — `scanContent` truncates it and scans the truncated text — so `runBench` does
 * the same rather than dropping an oversized file from the count entirely: a file this
 * large read in full would still only ever contribute its first ~200,000 characters to
 * a verdict, so reading further buys nothing but risk (a pathological input pulling
 * unbounded memory into the process). The full file size is still counted in `bytes`.
 */
const MAX_READ_BYTES = 1024 * 1024;

export interface RuleHit {
  readonly ruleId: string;
  readonly title: string;
  /** How many files in the corpus this rule fired on. */
  readonly files: number;
}

export interface BenchReport {
  readonly version: 1;
  readonly corpus: string;
  readonly files: number;
  readonly bytes: number;
  /** How many rules the shipped bundle enabled for this run. */
  readonly rules: number;
  readonly flagged: number;
  /** flagged / files, computed — never typed by a human. */
  readonly rate: number;
  /** Most files first, so the worst offender is the headline. */
  readonly byRule: readonly RuleHit[];
  readonly flaggedFiles: readonly string[];
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (TEXT.test(name)) out.push(full);
  }
}

/**
 * Reads at most `MAX_READ_BYTES` of `file`, via a bounded fixed-size buffer rather than
 * `readFileSync` — so a multi-gigabyte file cannot be pulled into memory whole just
 * because it happens to sit in the corpus directory. For a file at or under the bound
 * this reads the entire file, identically to `readFileSync(file, 'utf8')`.
 */
function readPrefix(file: string, maxBytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

/**
 * The vendored corpus, or null when it is not on disk — which is the normal case for
 * an npm install, since `vendor/` is outside the published package. The caller turns
 * that null into a message naming `--corpus`.
 *
 * Two candidates, not one: this module lives at `src/bench/run.ts` (two directories
 * below the package root) when run from source via tsx, but tsup bundles it into a
 * single `dist/index.js` (one directory below the package root) for the published
 * CLI. `import.meta.url` — and so the walk back up to the repository's `vendor/`
 * directory — differs by one level between the two, so both offsets are tried and
 * whichever exists on disk wins. A single hard-coded offset would silently resolve to
 * nothing in one of the two run modes, which `--corpus`-only tests would never catch.
 *
 * `base` defaults to this module's own `import.meta.url` and exists as a seam for
 * testing: a test can pass a `base` under a directory that has no `vendor/` anywhere
 * near it to exercise the null branch deterministically, without depending on the
 * disk layout the test happens to run from.
 */
export function defaultCorpusDir(base: string | URL = import.meta.url): string | null {
  const candidates = [
    // packages/cli/src/bench/run.ts -> repository root (4 levels up)
    new URL('../../../../vendor/bench-corpus/files', base),
    // packages/cli/dist/index.js (bundled) -> repository root (3 levels up)
    new URL('../../../vendor/bench-corpus/files', base),
  ];
  for (const url of candidates) {
    const dir = fileURLToPath(url);
    if (existsSync(dir)) return dir;
  }
  return null;
}

export function runBench(dir: string): BenchReport {
  const rules = loadBundledRules();
  const files: string[] = [];
  walk(dir, files);
  files.sort();

  const perRule = new Map<string, RuleHit>();
  const flaggedFiles: string[] = [];
  let bytes = 0;

  for (const file of files) {
    const size = statSync(file).size;
    bytes += size;
    const result = scanContent(rules, readPrefix(file, MAX_READ_BYTES));
    if (result.verdict !== 'suspect') continue;
    flaggedFiles.push(file);
    // Attribute the file to every rule that fired on it, deduped: one file that trips
    // the same rule through two variants is one file for that rule, not two.
    for (const id of new Set(result.matches.map((m) => m.ruleId))) {
      const match = result.matches.find((m) => m.ruleId === id);
      const prev = perRule.get(id);
      perRule.set(id, {
        ruleId: id,
        title: match?.title ?? id,
        files: (prev?.files ?? 0) + 1,
      });
    }
  }

  return {
    version: 1,
    corpus: dir,
    files: files.length,
    bytes,
    rules: rules.length,
    flagged: flaggedFiles.length,
    rate: files.length === 0 ? 0 : flaggedFiles.length / files.length,
    byRule: [...perRule.values()].sort((a, b) => b.files - a.files),
    flaggedFiles,
  };
}

const percent = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

export function formatBench(
  report: BenchReport,
  opts: { readonly verbose?: boolean } = {},
): string {
  const lines = [
    `stroq bench: ${report.files} files, ${Math.round(report.bytes / 1024)} KB, ${report.rules} rules`,
    `flagged:   ${report.flagged} / ${report.files}   (${percent(report.rate)})`,
  ];
  if (report.byRule.length === 0) {
    lines.push('', 'Nothing in this corpus trips a rule.');
  } else {
    lines.push('');
    for (const hit of report.byRule) {
      lines.push(
        `  ${hit.ruleId.padEnd(18)} ${hit.title.slice(0, 48).padEnd(48)} ${hit.files} file${hit.files === 1 ? '' : 's'}`,
      );
    }
  }
  if (opts.verbose && report.flaggedFiles.length > 0) {
    lines.push('', 'Flagged files:', ...report.flaggedFiles.map((f) => `  ${f}`));
  }
  lines.push('', `corpus: ${report.corpus}`);
  return `${lines.join('\n')}\n`;
}
