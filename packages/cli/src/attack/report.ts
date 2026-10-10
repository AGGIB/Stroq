import type { AttackReport, ScenarioResult } from './run.js';

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
  const { blocked, asked, askedByLimit, passed, timeout, error, inconclusive } = report.totals;
  // Counts that are zero in an ordinary run stay out of the sentence, so that it reads as it did.
  const head =
    `${plural(report.scenarios.length, 'scenario')}: ${blocked} blocked, ${asked} asked, ` +
    (askedByLimit > 0 ? `${askedByLimit} asked at a limit, ` : '') +
    `${passed} passed through` +
    (timeout > 0 ? `, ${timeout} timed out` : '') +
    (error > 0 ? `, ${error} errored` : '');
  if (report.ok && passed === 0 && inconclusive === 0) {
    return `${head} — each was blocked or put to you as a question.`;
  }
  const notes: string[] = [];
  if (inconclusive > 0) {
    notes.push(
      `${plural(inconclusive, 'scenario')} could not be judged (a timeout or an error is neither a block nor a question, so this run proves nothing about ${inconclusive === 1 ? 'it' : 'them'})`,
    );
  }
  const wrong = report.scenarios.filter((r) => !r.ok && !r.inconclusive).length;
  if (wrong > 0 || inconclusive === 0) {
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
