// Writes docs/COVERAGE.md and docs/BENCH.md straight from the commands' own
// output. Both documents are derived by importing buildCoverage/formatCoverage and
// runBench/formatBench and calling them in-process — never shelling out to the
// built CLI — so nothing about either document's shape or numbers can drift from
// the code that produces it. Mirrors scripts/build-atlas.ts: the default mode
// writes both files, and `--check` (CI) re-derives them in memory and
// byte-compares against the committed copies without writing anything.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { formatBench, runBench } from '../packages/cli/src/bench/run.js';
import { buildCoverage, formatCoverage } from '../packages/cli/src/coverage/report.js';

const root = resolve(import.meta.dirname, '..');
const coverageFile = join(root, 'docs/COVERAGE.md');
const benchFile = join(root, 'docs/BENCH.md');

/**
 * Repo-relative, deliberately never resolved to an absolute path: `runBench`
 * records exactly the string it is given as `report.corpus`, and `formatBench`
 * prints that string verbatim in its last line. An absolute path here would bake
 * the generating machine's home directory into a document every CI run diffs
 * against, which would fail on every machine but the one that generated it.
 */
const BENCH_CORPUS = 'vendor/bench-corpus/files';

function banner(command: string): string {
  return [
    '<!--',
    '  GENERATED FILE. Do not hand-edit.',
    `  Produced by \`pnpm generate:reports\` from \`${command}\`'s own output.`,
    '  Refresh it with `pnpm generate:reports`; `pnpm check:reports` fails CI if',
    "  this file and the command's live output disagree.",
    '-->',
    '',
  ].join('\n');
}

function deriveCoverage(): string {
  const report = buildCoverage();
  return [
    banner('stroq coverage'),
    '# Stroq coverage',
    '',
    `Stroq's control mapping against MITRE ATLAS ${report.atlasRelease} and OWASP ASI ` +
      `${report.asiEdition}: which in-scope techniques the attack corpus's scenarios ` +
      'evidence, and which do not.',
    '',
    'This is a control mapping with evidence, not a compliance claim. `covered` means at ' +
      'least one scenario in `stroq attack` exercises the technique end to end with no ' +
      'stated limitation; `partial` means a scenario exercises it but a recorded ' +
      'limitation narrows what that evidence proves; `not covered` means no scenario tags ' +
      'it yet, whatever the scope declaration below says about the surface — a stated ' +
      'limitation on an untagged technique is a claim about the surface, not evidence the ' +
      'corpus proves it.',
    '',
    'Which techniques are in scope for a local, hook-based action firewall at all, and why ' +
      'the rest of the vendored ATLAS denominator is not, is declared in ' +
      '[`packages/cli/src/coverage/scope.json`](../packages/cli/src/coverage/scope.json), ' +
      'with its method documented in ' +
      '[`packages/cli/src/coverage/SCOPE.md`](../packages/cli/src/coverage/SCOPE.md).',
    '',
    'Reproduce this table with `stroq coverage`, or load the same mapping into MITRE ' +
      'ATT&CK Navigator with `stroq coverage --format=navigator`.',
    '',
    '```text',
    formatCoverage(report).trimEnd(),
    '```',
    '',
  ].join('\n');
}

function deriveBench(): string {
  const report = runBench(BENCH_CORPUS);
  return [
    banner(`stroq bench --corpus ${BENCH_CORPUS}`),
    '# Stroq bench',
    '',
    "Stroq's false-positive rate against real, benign developer documentation. This " +
      'number is ours — measured by a method we publish, on a corpus we vendor. It is not ' +
      'a third-party audit.',
    '',
    '```text',
    formatBench(report, { verbose: true }).trimEnd(),
    '```',
    '',
    'Every file the list above names is unmodified, ordinary documentation belonging to ' +
      'its own project. Appearing in it means a Stroq rule fired in error on that file — ' +
      'it is not a statement that the file, or the project it comes from, did anything ' +
      'wrong.',
    '',
    '## Method',
    '',
    'Production scans under a 500 ms wall-clock budget (`DEFAULT_BUDGET_MS`, ' +
      '[`packages/core/src/scan/scanner.ts`](../packages/core/src/scan/scanner.ts)) and ' +
      "fails closed the moment it runs out — verdict: 'suspect' plus a synthetic " +
      'STROQ-SCAN-BUDGET match — because a slow scan must never hang a tool call. This ' +
      'bench deliberately uses a far larger budget, 60,000 ms (`BENCH_BUDGET_MS`, ' +
      '[`packages/cli/src/bench/run.ts`](../packages/cli/src/bench/run.ts)): it is ' +
      'measuring which rules match real documentation, not how fast the machine ' +
      'producing this report happens to be, and a timeout-induced verdict is not a rule ' +
      'false positive — folding one into the count above would both overstate the rate ' +
      'and make it depend on the runner rather than the rules. If a scan still exceeds ' +
      'even the 60 s bench budget, it is reported as a `timedOut` line above rather than ' +
      "folded silently into a rule's hit count.",
    '',
    'The corpus is vendored, unmodified, third-party developer documentation — ' +
      'README, CONTRIBUTING, SECURITY and configuration files pulled from real ' +
      'Apache-2.0-licensed projects — fetched at an exact resolved commit and pinned by ' +
      'sha256 for every file in ' +
      '[`vendor/bench-corpus/sources.json`](../vendor/bench-corpus/sources.json); ' +
      '`pnpm check:bench-corpus` fails CI if a committed file no longer matches the ' +
      'hash the manifest recorded for it. See ' +
      '[`vendor/bench-corpus/PROVENANCE.md`](../vendor/bench-corpus/PROVENANCE.md) for why ' +
      'each source was chosen.',
    '',
    'This corpus is deliberately disjoint from `rules/fixtures/benign`, a separate, ' +
      'much smaller corpus that `stroq bench` never reads: `scripts/build-rules.ts` runs ' +
      'every ATR rule against those fixtures at build time and disables any rule that ' +
      'fires on one, which is where the disabled rules in the shipped bundle come from. ' +
      'Measuring the false-positive rate against that same corpus would report a number ' +
      'close to zero by construction — the rules were tuned on it — regardless of how ' +
      'they behave on text they were never checked against, so the number above would be ' +
      'measuring the build gate rather than the rules. `packages/cli/test/bench/' +
      'corpus.test.ts` enforces the two corpora share no file by hashing both ' +
      'directories, rather than relying on nobody copying a file across.',
    '',
    '`stroq bench --corpus <dir>` reproduces this measurement on your own files. The ' +
      'vendored corpus this document measures ships with the repository, not with the ' +
      'published npm package — `stroq bench` with no `--corpus` looks for it next to the ' +
      'installed CLI and, not finding it there, tells you to pass `--corpus` yourself, ' +
      'which is always the case for an installed CLI.',
    '',
  ].join('\n');
}

interface Target {
  readonly label: string;
  readonly file: string;
  readonly derive: () => string;
}

const targets: readonly Target[] = [
  { label: 'docs/COVERAGE.md', file: coverageFile, derive: deriveCoverage },
  { label: 'docs/BENCH.md', file: benchFile, derive: deriveBench },
];

const checkMode = process.argv.includes('--check');
let outOfDate = false;

for (const { label, file, derive } of targets) {
  const derived = derive();
  if (!checkMode) {
    writeFileSync(file, derived);
    process.stdout.write(`${label}: written\n`);
    continue;
  }
  const committed = readFileSync(file, 'utf8');
  if (committed === derived) {
    process.stdout.write(`${label} is current\n`);
  } else {
    process.stderr.write(
      `${label} is out of date: run "pnpm generate:reports" locally and commit ${label}\n`,
    );
    outOfDate = true;
  }
}

if (outOfDate) process.exitCode = 1;
