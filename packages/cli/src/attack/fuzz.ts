import type { Policy } from '@stroq/core';
import { mutateScenario, type Mutation } from './mutate.js';
import { runScenario, type Outcome } from './run.js';
import type { Scenario } from './scenario.js';

export interface VariantResult {
  readonly scenarioId: string;
  readonly mutationId: string;
  readonly preserving: boolean;
  /** Null when the variant errored before it could be run — see `error`. */
  readonly outcome: Outcome | null;
  readonly ruleId: string | null;
  /**
   * Why there is no verdict: the mutation's thrown error message (then `outcome` is null), or, for
   * a variant in `inconclusive`, what stopped the run from judging it. Null for every variant that
   * was judged.
   */
  readonly error: string | null;
}

export interface FuzzReport {
  readonly version: 1;
  readonly policy: string;
  readonly scenarios: number;
  readonly mutations: number;
  /**
   * Variants actually produced and run — textless cells and errored cells are not counted here.
   * Every one is in exactly one of `survived`, `escaped`, `recorded` and `inconclusive`.
   */
  readonly variants: number;
  /** Variants that were blocked or asked about, judged by a rule or by a limit (`survivedByLimit`). */
  readonly survived: number;
  /** Of `survived`, those asked about because Stroq could not read them, with no rule naming a danger. */
  readonly survivedByLimit: number;
  /** Semantics-preserving variants that reached `allow`. This list is the deliverable. */
  readonly escaped: readonly VariantResult[];
  /** Non-preserving variants that reached `allow`: printed, never asserted. */
  readonly recorded: readonly VariantResult[];
  /** Variants whose mutation threw instead of producing text — printed, never asserted. */
  readonly errored: readonly VariantResult[];
  /**
   * Variants that were run but could not be judged: a step timed out or threw. They are neither
   * survived nor escaped (a fail-closed timeout looks exactly like a block, and a pass after one
   * is not a clean pass), and any of them fails the run. Each keeps the outcome it had and says why.
   */
  readonly inconclusive: readonly VariantResult[];
  readonly notApplicable: number;
  /** Scenarios that carry no untrusted text, so no variant could be built from them. */
  readonly textless: readonly string[];
  readonly ok: boolean;
}

/** Builds the errored record for a mutation whose `apply` threw instead of producing a variant. */
function erroredVariant(scenario: Scenario, mutation: Mutation, err: unknown): VariantResult {
  return {
    scenarioId: scenario.id,
    mutationId: mutation.id,
    preserving: mutation.preserving,
    outcome: null,
    ruleId: null,
    error: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Crosses every scenario with every mutation and runs each variant through the real
 * policy engine. A mutation that throws (e.g. `url-encoded` on an unpaired UTF-16
 * surrogate) is caught per-variant and recorded in `errored` — it must not abort the
 * whole run, since the corpus grows over time and no single fixture should be able to
 * take the suite down mid-pass.
 */
export async function runFuzz(
  scenarios: readonly Scenario[],
  mutations: readonly Mutation[],
  policy: Policy,
  policySource: string,
  onProgress?: (done: number, total: number) => void,
): Promise<FuzzReport> {
  const escaped: VariantResult[] = [];
  const recorded: VariantResult[] = [];
  const errored: VariantResult[] = [];
  const inconclusive: VariantResult[] = [];
  const textless = new Set<string>();
  let variants = 0;
  let survived = 0;
  let survivedByLimit = 0;
  let notApplicable = 0;
  const total = scenarios.length * mutations.length;
  let done = 0;

  for (const scenario of scenarios)
    for (const mutation of mutations) {
      done += 1;
      let mutated: Scenario | null;
      try {
        mutated = mutateScenario(scenario, mutation);
      } catch (err) {
        errored.push(erroredVariant(scenario, mutation, err));
        onProgress?.(done, total);
        continue;
      }
      if (mutated === null) {
        notApplicable += 1;
        textless.add(scenario.id);
        onProgress?.(done, total);
        continue;
      }
      const result = await runScenario(mutated, policy);
      variants += 1;
      const variant: VariantResult = {
        scenarioId: scenario.id,
        mutationId: mutation.id,
        preserving: mutation.preserving,
        outcome: result.outcome,
        ruleId: result.ruleId,
        error: result.reason,
      };
      if (result.inconclusive) {
        // Not judged: counted as neither a block nor a pass, even when the attack step let it through.
        inconclusive.push(variant);
      } else if (result.outcome === 'passed') {
        (mutation.preserving ? escaped : recorded).push(variant);
      } else {
        survived += 1;
        if (result.outcome === 'asked-by-limit') survivedByLimit += 1;
      }
      onProgress?.(done, total);
    }

  return {
    version: 1,
    policy: policySource,
    scenarios: scenarios.length,
    mutations: mutations.length,
    variants,
    survived,
    survivedByLimit,
    escaped,
    recorded,
    errored,
    inconclusive,
    notApplicable,
    textless: [...textless],
    // A run that could not judge a variant cannot say that nothing escaped.
    ok: escaped.length === 0 && inconclusive.length === 0,
  };
}

const ID_WIDTH = 32;
const MUTATION_WIDTH = 32;

const variantLine = (v: VariantResult): string =>
  `  ${v.scenarioId.padEnd(ID_WIDTH)} ${v.mutationId.padEnd(MUTATION_WIDTH)} allow    (${v.ruleId ?? 'no rule'})`;

const erroredLine = (v: VariantResult): string =>
  `  ${v.scenarioId.padEnd(ID_WIDTH)} ${v.mutationId.padEnd(MUTATION_WIDTH)} ${v.error ?? 'unknown error'}`;

const inconclusiveLine = (v: VariantResult): string =>
  `  ${v.scenarioId.padEnd(ID_WIDTH)} ${v.mutationId.padEnd(MUTATION_WIDTH)} ${v.outcome ?? '-'}: ${v.error ?? 'no reason recorded'}`;

const ratio = (part: number, whole: number): string =>
  whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`;

export function formatFuzz(report: FuzzReport): string {
  // The variants come from the scenarios that carry untrusted text; the others have nothing
  // to mutate, and a header that multiplied all of them said more than was run.
  const mutated = report.scenarios - report.textless.length;
  const apart =
    report.textless.length === 0
      ? ''
      : ` (${report.textless.length} of ${report.scenarios} scenarios carry no untrusted text and are not mutated)`;
  const lines = [
    `stroq attack --fuzz: ${mutated} scenarios x ${report.mutations} mutations = ${report.variants} variants${apart}, policy ${report.policy}`,
    `survived:  ${report.survived} / ${report.variants}   (${ratio(report.survived, report.variants)})`,
    ...(report.survivedByLimit > 0
      ? [
          `           ${report.survivedByLimit} of them were asked because Stroq could not read them, with no rule naming a danger`,
        ]
      : []),
    `escaped:   ${report.escaped.length}`,
    ...report.escaped.map(variantLine),
  ];
  if (report.escaped.length === 0 && report.inconclusive.length === 0)
    lines.push('  no escapes: every semantics-preserving variant was stopped.');
  if (report.inconclusive.length > 0) {
    lines.push(
      `inconclusive: ${report.inconclusive.length} (a timeout or an error is neither a block nor a pass, so nothing can be said about these variants; the run fails)`,
      ...report.inconclusive.map(inconclusiveLine),
    );
  }
  if (report.recorded.length > 0) {
    lines.push(
      `recorded, not asserted: ${report.recorded.length} (the mutation destroys the payload, so getting through proves nothing)`,
      ...report.recorded.map(variantLine),
    );
  }
  if (report.errored.length > 0) {
    lines.push(
      `errored: ${report.errored.length} (the mutation itself threw and could not be produced, so nothing ran)`,
      ...report.errored.map(erroredLine),
    );
  }
  if (report.notApplicable > 0) {
    lines.push(
      `not applicable: ${report.notApplicable} — ${report.textless.length} scenario(s) carry no untrusted text to mutate: ${report.textless.join(', ')}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
