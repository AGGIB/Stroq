import { neutralizeControls } from '../terminal-safe.js';
import { policySha256 } from './digest.js';
import { BUNDLED, replay, type Suites } from './replay.js';
import { formatTest } from './test-format.js';
import { loadBaseline, loadCandidate, loadCases, type Side } from './test-inputs.js';
import { buildTestReport, type TestReport } from './test-report.js';

/** Exit codes: 0 the gate held, 1 it did not, 2 the command line is wrong or an input cannot be read. */
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

export interface TestFlags {
  readonly policy: string | undefined;
  readonly baseline: string | undefined;
  readonly cases: string | undefined;
  /** The text of `--max-new-interruptions`, not yet checked. */
  readonly maxNewInterruptions: string | undefined;
  readonly json: boolean;
}

const WHOLE_NUMBER = /^\d{1,9}$/;

/** Whatever reaches the terminal is neutralized here, as `check` does: the inputs are somebody's text. */
const write = (stream: NodeJS.WriteStream, text: string): void => {
  stream.write(neutralizeControls(text));
};

const fail = (lines: readonly string[]): number => {
  write(process.stderr, `${lines.join('\n')}\n`);
  return EXIT_USAGE;
};

/** Both policies, replayed over the same corpora, compared. */
export async function testPolicies(
  candidate: Side,
  baseline: Side,
  suites: Suites,
  maxNewInterruptions: number | null,
): Promise<TestReport> {
  const baselineRecords = await replay(baseline.policy, suites);
  const candidateRecords = await replay(candidate.policy, suites);
  return buildTestReport({
    candidate: { source: candidate.source, sha256: policySha256(candidate.policy) },
    baseline: { source: baseline.source, sha256: policySha256(baseline.policy) },
    baselineRecords,
    candidateRecords,
    maxNewInterruptions,
  });
}

/**
 * `stroq policy test`: what an edit to a policy does, before it is relied on.
 *
 * The candidate (`--policy`, or the policy in force) and the baseline (`--baseline`, or the built-in
 * policy) are each run over the attack corpus, the ordinary-work benchmark and the person's own
 * cases, in this process, in throwaway folders; nothing is started and nothing leaves the machine.
 * What is printed is the difference, then what it adds up to. An attack that passes, an expectation
 * that is not met, a scenario that could not be judged (a timeout is not a defence) or more new
 * interruptions of ordinary work than `--max-new-interruptions` allows make the exit 1.
 */
export async function runTestCommand(flags: TestFlags): Promise<number> {
  if (flags.maxNewInterruptions !== undefined && !WHOLE_NUMBER.test(flags.maxNewInterruptions)) {
    return fail(['stroq policy test: --max-new-interruptions needs a whole number, 0 or more']);
  }
  const candidate = loadCandidate(flags.policy);
  if (!candidate.ok) return fail(candidate.lines);
  const baseline = loadBaseline(flags.baseline);
  if (!baseline.ok) return fail(baseline.lines);
  const cases = loadCases(flags.cases);
  if (!cases.ok) return fail(cases.lines);
  const max = flags.maxNewInterruptions === undefined ? null : Number(flags.maxNewInterruptions);
  const report = await testPolicies(
    candidate.value,
    baseline.value,
    { ...BUNDLED, cases: cases.value },
    max,
  );
  write(process.stdout, flags.json ? `${JSON.stringify(report, null, 2)}\n` : formatTest(report));
  return report.ok ? 0 : EXIT_FAILED;
}
