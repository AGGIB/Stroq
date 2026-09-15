import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUDGET_MATCH, loadBundledRules, scanContent } from '@stroq/core';

/** Text extensions only: the corpus is documentation, and a binary would measure nothing. */
const TEXT = /\.(?:md|rst|txt|adoc)$/i;
/**
 * Wall-clock scan budget the bench passes to `scanContent`, deliberately far above
 * production's `DEFAULT_BUDGET_MS` (500 ms, `packages/core/src/scan/scanner.ts`).
 * Production fails a scan closed — verdict: 'suspect' plus a synthetic
 * STROQ-SCAN-BUDGET match — the moment it runs long, because a slow scan must never
 * hang a tool call; that is a latency trade-off, not a judgement about the text. The
 * bench is measuring a different thing: which rules match real documentation, not how
 * fast the machine producing this report happens to be. Passing no budget here would
 * inherit the 500 ms production one, and a timeout-induced 'suspect' is not a rule
 * false-positive — it would both overstate the reported rate and make the published
 * number depend on the CI runner's clock speed rather than on the rules, which is
 * exactly what made `docs/BENCH.md` drift between machines. 60 s is comfortably above
 * anything in the vendored corpus takes to scan (its slowest file measures well under
 * 1 s locally), so it should never be hit in practice — see `timedOut` on
 * `BenchReport` for what happens if it somehow is.
 */
export const BENCH_BUDGET_MS = 60_000;
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
  /**
   * How many files' scans hit `BENCH_BUDGET_MS` and were forced 'suspect' by the
   * scanner's fail-closed timeout behaviour rather than by a rule genuinely matching.
   * Should be 0 — `BENCH_BUDGET_MS` is chosen so this never happens in practice — and
   * `formatBench` says nothing about it when it is. A non-zero value here means the
   * bench's own measurement was degraded on this run; `byRule` never attributes these
   * scans to a rule, since STROQ-SCAN-BUDGET is not one of the `rules` the bundle
   * shipped.
   */
  readonly timedOut: number;
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
  let timedOut = 0;

  for (const file of files) {
    const size = statSync(file).size;
    bytes += size;
    // `repo_content`: the corpus is third-party documentation, and naming that surface
    // is what makes the reported rate a rate *for documentation* rather than for every
    // rule the bundle ships regardless of where it was written to read. It also changes
    // what the number means — see docs/BENCH.md's Method section.
    const result = scanContent(
      rules,
      readPrefix(file, MAX_READ_BYTES),
      { budgetMs: BENCH_BUDGET_MS },
      { target: 'repo_content' },
    );
    if (result.timedOut) timedOut += 1;
    if (result.verdict !== 'suspect') continue;
    flaggedFiles.push(file);
    // Attribute the file to every rule that fired on it, deduped: one file that trips
    // the same rule through two variants is one file for that rule, not two. The
    // synthetic STROQ-SCAN-BUDGET match is excluded: it is not one of the `rules` the
    // bundle shipped, and folding it into this table would misreport a timeout as a
    // rule false-positive. `timedOut` above is where it is counted instead.
    for (const id of new Set(result.matches.map((m) => m.ruleId))) {
      if (id === BUDGET_MATCH.ruleId) continue;
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
    timedOut,
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
  if (report.timedOut > 0) {
    const noun = report.timedOut === 1 ? 'scan' : 'scans';
    lines.push(
      `timedOut:  ${report.timedOut} ${noun} hit the bench's scan budget and were forced ` +
        `suspect by that alone, not by a rule match — see docs/BENCH.md's Method section.`,
    );
  }
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
