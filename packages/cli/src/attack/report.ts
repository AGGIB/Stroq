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

function scenarioLine(result: ScenarioResult): string {
  const mark = result.ok ? '✔' : '✘';
  const rule = (result.ruleId ?? '-').padEnd(RULE_WIDTH);
  const incident = `${result.incident.name} (${result.incident.date})`;
  return `${mark} ${result.id.padEnd(ID_WIDTH)} ${result.outcome.padEnd(OUTCOME_WIDTH)} ${rule} ${incident}${result.ok ? '' : mismatch(result)}`;
}

function summaryLine(report: AttackReport): string {
  const { blocked, asked, passed } = report.totals;
  const head = `${plural(report.scenarios.length, 'scenario')}: ${blocked} blocked, ${asked} asked, ${passed} passed through`;
  if (report.ok) return `${head} — every attack was stopped.`;
  const wrong = report.scenarios.filter((r) => !r.ok).length;
  return `${head} — ${plural(wrong, 'scenario')} did not behave as expected; your policy is weaker than the default (compare it with policies/default.yaml).`;
}

export function formatReport(report: AttackReport): string {
  const header = `stroq attack: ${plural(report.scenarios.length, 'recorded incident')} against policy ${report.policy}`;
  return `${[header, ...report.scenarios.map(scenarioLine), summaryLine(report)].join('\n')}\n`;
}
