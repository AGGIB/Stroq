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
  /** The mutation's thrown error message, or null for every variant that actually ran. */
  readonly error: string | null;
}

export interface FuzzReport {
  readonly version: 1;
  readonly policy: string;
  readonly scenarios: number;
  readonly mutations: number;
  /** Variants actually produced and run — textless cells and errored cells are not counted here. */
  readonly variants: number;
  readonly survived: number;
  /** Semantics-preserving variants that reached `allow`. This list is the deliverable. */
  readonly escaped: readonly VariantResult[];
  /** Non-preserving variants that reached `allow`: printed, never asserted. */
  readonly recorded: readonly VariantResult[];
  /** Variants whose mutation threw instead of producing text — printed, never asserted. */
  readonly errored: readonly VariantResult[];
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
  const textless = new Set<string>();
  let variants = 0;
  let survived = 0;
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
        error: null,
      };
      if (result.outcome !== 'passed') survived += 1;
      else if (mutation.preserving) escaped.push(variant);
      else recorded.push(variant);
      onProgress?.(done, total);
    }

  return {
    version: 1,
    policy: policySource,
    scenarios: scenarios.length,
    mutations: mutations.length,
    variants,
    survived,
    escaped,
    recorded,
    errored,
    notApplicable,
    textless: [...textless],
    ok: escaped.length === 0,
  };
}

const ID_WIDTH = 32;
const MUTATION_WIDTH = 32;

const variantLine = (v: VariantResult): string =>
  `  ${v.scenarioId.padEnd(ID_WIDTH)} ${v.mutationId.padEnd(MUTATION_WIDTH)} allow    (${v.ruleId ?? 'no rule'})`;

const erroredLine = (v: VariantResult): string =>
  `  ${v.scenarioId.padEnd(ID_WIDTH)} ${v.mutationId.padEnd(MUTATION_WIDTH)} ${v.error ?? 'unknown error'}`;

const ratio = (part: number, whole: number): string =>
  whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`;

export function formatFuzz(report: FuzzReport): string {
  const lines = [
    `stroq attack --fuzz: ${report.scenarios} scenarios x ${report.mutations} mutations = ${report.variants} variants, policy ${report.policy}`,
    `survived:  ${report.survived} / ${report.variants}   (${ratio(report.survived, report.variants)})`,
    `escaped:   ${report.escaped.length}`,
    ...report.escaped.map(variantLine),
  ];
  if (report.escaped.length === 0)
    lines.push('  no escapes: every semantics-preserving variant was stopped.');
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
