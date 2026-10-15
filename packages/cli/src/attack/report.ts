import { createHash } from 'node:crypto';
import { stableStringify, type Policy } from '@stroq/core';
import type { ClaudeHookEvent } from '../adapters/claude-code.js';
import { stroqVersion } from '../version.js';
import type { AttackReport, ScenarioResult } from './run.js';

/**
 * What every report of version 2 says about the run that made it, so that two reports can be told
 * apart and one can be read without the machine it came from: which Stroq, which policy, what the
 * "host" was, what was replayed.
 */
export interface ReportMeta {
  /** The version of the CLI that made the report. */
  readonly stroq: string;
  readonly policy: {
    /** `default` or the path of the policy override that was used. */
    readonly source: string;
    /** `sha256` of the policy as loaded; see `buildMeta` for what exactly is hashed. */
    readonly sha256: string;
  };
  /**
   * What the events were sent to. These reports replay the events a Claude Code hook would send
   * into the engine in this process, so there is no host and no version of one: `mode` says so.
   */
  readonly host: {
    readonly id: 'claude-code';
    readonly version: null;
    readonly mode: 'in-process';
  };
  /** Every tool named by the steps that were replayed, once each, sorted. */
  readonly tools: readonly string[];
  /** Not run under a sandbox: nothing here starts a process. */
  readonly sandbox: null;
  readonly corpus: {
    readonly id: string;
    /** `sha256` of the scenarios as given; see `buildMeta`. */
    readonly sha256: string;
    readonly count: number;
  };
}

export interface MetaInput {
  readonly policy: Policy;
  readonly policySource: string;
  readonly corpusId: string;
  /** The scenarios that were replayed: only their steps' events and their own data are read. */
  readonly scenarios: readonly { readonly steps: readonly { readonly event: ClaudeHookEvent }[] }[];
}

/** The id the attack suite and its fuzzer give the corpus they replay (they share the scenarios). */
export const ATTACK_CORPUS_ID = 'attack-scenarios';

const sha256Of = (value: unknown): string =>
  createHash('sha256').update(stableStringify(value)).digest('hex');

/**
 * The meta block of a report of version 2.
 *
 * Both hashes are of canonical JSON (keys sorted, no whitespace) of the data as the code holds it,
 * not of any file's bytes: the policy is hashed as parsed, so the built-in policy (which lives in
 * code and has no file) has a hash like any other, and a comment or a reordering in a policy file
 * does not change it; the corpus is hashed as the scenarios that were replayed, so a `--only` run
 * says what it ran. The same data hashes the same on every machine.
 */
export function buildMeta(input: MetaInput): ReportMeta {
  const tools = new Set<string>();
  for (const scenario of input.scenarios)
    for (const step of scenario.steps)
      if (typeof step.event.tool_name === 'string') tools.add(step.event.tool_name);
  return {
    stroq: stroqVersion(),
    policy: { source: input.policySource, sha256: sha256Of(input.policy) },
    host: { id: 'claude-code', version: null, mode: 'in-process' },
    tools: [...tools].sort(),
    sandbox: null,
    corpus: {
      id: input.corpusId,
      sha256: sha256Of(input.scenarios),
      count: input.scenarios.length,
    },
  };
}

const ID_WIDTH = 32;
const OUTCOME_WIDTH = 8;
const RULE_WIDTH = 34;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function mismatch(result: ScenarioResult): string {
  const index = result.steps.findIndex((s) => s.actual !== s.expect);
  const step = result.steps[index];
  if (!step) return '';
  return ` (step ${index + 1} ${step.phase} ${step.tool}: expected ${step.expect}, got ${step.actual})`;
}

/** What follows a scenario's line: why it could not be judged, or where it went wrong. */
function detail(result: ScenarioResult): string {
  if (result.inconclusive) return ` (inconclusive: ${result.reason ?? 'no reason recorded'})`;
  if (result.unsupportedSteps && result.unsupportedSteps.length > 0) {
    const unsuppDetails = result.steps
      .map((s, idx) => (s.supported === false ? `step ${idx + 1} (${s.channel ?? s.tool})` : null))
      .filter((s): s is string => s !== null)
      .join(', ');
    return ` (unsupported on host: ${unsuppDetails})`;
  }
  return result.ok ? '' : mismatch(result);
}

function scenarioLine(result: ScenarioResult): string {
  // `?` is neither a pass nor a fail: a timeout or an error says nothing about the policy.
  const mark = result.inconclusive ? '?' : result.ok ? '✔' : '✘';
  const rule = (result.ruleId ?? '-').padEnd(RULE_WIDTH);
  const incident =
    result.incident === null
      ? `${result.class ?? 'synthetic cell'} (synthetic)`
      : `${result.incident.name} (${result.incident.date})`;
  return `${mark} ${result.id.padEnd(ID_WIDTH)} ${result.outcome.padEnd(OUTCOME_WIDTH)} ${rule} ${incident}${detail(result)}`;
}

function summaryLine(report: AttackReport): string {
  const { blocked, asked, askedByLimit, passed, timeout, error, inconclusive, unsupportedSteps } =
    report.totals;
  // Counts that are zero in an ordinary run stay out of the sentence, so that it reads as it did.
  const head =
    `${plural(report.scenarios.length, 'scenario')}: ${blocked} blocked, ${asked} asked, ` +
    (askedByLimit > 0 ? `${askedByLimit} asked at a limit, ` : '') +
    `${passed} passed through` +
    (unsupportedSteps !== undefined && unsupportedSteps > 0
      ? `, ${plural(unsupportedSteps, 'step')} unsupported`
      : '') +
    (timeout > 0 ? `, ${timeout} timed out` : '') +
    (error > 0 ? `, ${error} errored` : '');
  if (
    report.ok &&
    passed === 0 &&
    inconclusive === 0 &&
    (!unsupportedSteps || unsupportedSteps === 0)
  ) {
    return `${head} — each was blocked or put to you as a question.`;
  }
  const notes: string[] = [];
  if (unsupportedSteps !== undefined && unsupportedSteps > 0) {
    notes.push(
      `${plural(unsupportedSteps, 'step')} unsupported on host ${report.host ?? 'specified'} (unsupported steps are not counted as protection)`,
    );
  }
  if (inconclusive > 0) {
    notes.push(
      `${plural(inconclusive, 'scenario')} could not be judged (a timeout or an error is neither a block nor a question, so this run proves nothing about ${inconclusive === 1 ? 'it' : 'them'})`,
    );
  }
  const wrong = report.scenarios.filter(
    (r) => !r.ok && !r.inconclusive && (!r.unsupportedSteps || r.unsupportedSteps.length === 0),
  ).length;
  if (wrong > 0 || (inconclusive === 0 && (!unsupportedSteps || unsupportedSteps === 0))) {
    notes.push(
      `${plural(wrong, 'scenario')} did not behave as expected; your policy is weaker than the default (compare it with policies/default.yaml)`,
    );
  }
  return `${head} — ${notes.join('; ')}.`;
}

export function formatReport(report: AttackReport): string {
  // Counted apart, as the suite's own schema counts them: a documented incident cites its
  // report and a synthetic cell does not, and a header that called all of them incidents
  // claimed more than the suite has.
  const documented = report.scenarios.filter((r) => r.incident !== null).length;
  const synthetic = report.scenarios.length - documented;
  const header = `stroq attack: ${plural(report.scenarios.length, 'scenario')} against policy ${report.policy} (${documented} from public reports, ${synthetic} synthetic)`;
  return `${[header, ...report.scenarios.map(scenarioLine), summaryLine(report)].join('\n')}\n`;
}
