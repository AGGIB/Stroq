import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBundledRules, scanContent } from '@stroq/core';

/** Text extensions only: the corpus is documentation, and a binary would measure nothing. */
const TEXT = /\.(?:md|rst|txt|adoc)$/i;
/** Files larger than this are skipped and reported as skipped; docs are small. */
const MAX_FILE_BYTES = 1024 * 1024;

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
 */
export function defaultCorpusDir(): string | null {
  const candidates = [
    // packages/cli/src/bench/run.ts -> repository root (4 levels up)
    new URL('../../../../vendor/bench-corpus/files', import.meta.url),
    // packages/cli/dist/index.js (bundled) -> repository root (3 levels up)
    new URL('../../../vendor/bench-corpus/files', import.meta.url),
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
    if (size > MAX_FILE_BYTES) continue;
    const result = scanContent(rules, readFileSync(file, 'utf8'));
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
