import { closed, count, hash, member, stamp } from './local-guards';

export const ACTION_LABELS = {
  'shell.exec_encoded': 'Encoded execution',
  'shell.network': 'Outbound shell command',
  'shell.destructive': 'Destructive command',
  'shell.unparsed': 'Unparsed execution',
  'fs.secrets': 'Credential file access',
  'fs.canary': 'Canary file access',
  'git.push_external': 'External Git push',
  'config.self': 'Stroq configuration',
  'config.self_touch': 'Stroq state access',
  'config.git_exec': 'Git execution settings',
  'config.persistence': 'Persistent execution',
  'config.instructions': 'Agent instructions',
  'config.instructions_payload': 'Suspect instruction write',
  'network.fetch': 'Web fetch',
  'mcp.call': 'MCP call',
  'mcp.side_effect': 'MCP side effect',
  'origin.untrusted': 'Untrusted source',
  'origin.suspect': 'Suspect source',
  'secret.egress': 'Credential in outbound input',
  'secret.unscannable': 'Credential check incomplete',
} as const;
export type RecordedActionClass = keyof typeof ACTION_LABELS;
export const COMPARISON_LIMITATIONS = [
  'The original taint state was not recorded. These are two current-policy scenarios, not a replay of the original decision.',
  'Only the recorded action classes and current server policy are evaluated. Task scope, trust exemptions, host adapters and runtime guards are not evaluated.',
  'The current server policy is not proof that an installed host loaded this policy. The original policy version was not recorded.',
  'Agreement or a changed decision does not establish host execution, blocking, credential rotation or remediation.',
  'Commands, content, session identifiers, paths, custom rule identifiers and reasons are withheld. The journal hash chain is not verified by this comparison.',
  'Policy scan threshold is not used when evaluating recorded action classes.',
] as const;
export type PolicyEffect = 'allow' | 'ask' | 'deny';
export interface PolicyScenario {
  taint: 'none' | 'suspect';
  effect: PolicyEffect;
  matchedRule: null | {
    index: number;
    classes: RecordedActionClass[];
    taint: 'any' | 'none' | 'suspect';
  };
}
export interface IncidentComparison {
  schema: 'stroq-incident-comparison/1';
  source: 'local';
  incidentId: string;
  evidenceSha: string;
  comparedAt: string;
  currentPolicy: {
    source: 'built-in' | 'file';
    semanticSha: string;
    rawSha: string | null;
    rules: number;
  };
  previousEffect: 'deny' | 'ask';
  classes: RecordedActionClass[];
  scopeRecorded: boolean;
  scenarios: [PolicyScenario, PolicyScenario];
  relation: 'matchesRecorded' | 'changed' | 'mixed';
  limitations: string[];
}
const classes = (value: unknown): value is RecordedActionClass[] =>
  Array.isArray(value) &&
  value.length <= 20 &&
  new Set(value).size === value.length &&
  value.every((item) => member(item, Object.keys(ACTION_LABELS)));
function scenario(
  value: unknown,
  report: IncidentComparison,
  taint: PolicyScenario['taint'],
): value is PolicyScenario {
  if (
    !closed(value, ['taint', 'effect', 'matchedRule']) ||
    value.taint !== taint ||
    !member(value.effect, ['allow', 'ask', 'deny'])
  )
    return false;
  const rule = value.matchedRule;
  return (
    rule === null ||
    (closed(rule, ['index', 'classes', 'taint']) &&
      count(rule.index, report.currentPolicy.rules - 1) &&
      classes(rule.classes) &&
      rule.classes.length > 0 &&
      rule.classes.some((item) => report.classes.includes(item)) &&
      member(rule.taint, ['any', taint]))
  );
}
export function validateIncidentComparison(value: unknown): value is IncidentComparison {
  if (
    !closed(value, [
      'schema',
      'source',
      'incidentId',
      'evidenceSha',
      'comparedAt',
      'currentPolicy',
      'previousEffect',
      'classes',
      'scopeRecorded',
      'scenarios',
      'relation',
      'limitations',
    ]) ||
    value.schema !== 'stroq-incident-comparison/1' ||
    value.source !== 'local' ||
    !hash(value.evidenceSha) ||
    value.incidentId !== `incident-${value.evidenceSha}` ||
    !stamp(value.comparedAt) ||
    !closed(value.currentPolicy, ['source', 'semanticSha', 'rawSha', 'rules']) ||
    !member(value.currentPolicy.source, ['built-in', 'file']) ||
    !hash(value.currentPolicy.semanticSha) ||
    !count(value.currentPolicy.rules, 512) ||
    !(value.currentPolicy.source === 'built-in'
      ? value.currentPolicy.rawSha === null
      : hash(value.currentPolicy.rawSha)) ||
    !member(value.previousEffect, ['deny', 'ask']) ||
    !classes(value.classes) ||
    typeof value.scopeRecorded !== 'boolean' ||
    !Array.isArray(value.scenarios) ||
    value.scenarios.length !== 2 ||
    !member(value.relation, ['matchesRecorded', 'changed', 'mixed']) ||
    !Array.isArray(value.limitations) ||
    value.limitations.length !== COMPARISON_LIMITATIONS.length ||
    value.limitations.some((item, i) => item !== COMPARISON_LIMITATIONS[i])
  )
    return false;
  const report = value as unknown as IncidentComparison;
  if (
    !scenario(report.scenarios[0], report, 'none') ||
    !scenario(report.scenarios[1], report, 'suspect')
  )
    return false;
  const matching = report.scenarios.filter((item) => item.effect === report.previousEffect).length;
  return (
    report.relation === (matching === 2 ? 'matchesRecorded' : matching === 1 ? 'mixed' : 'changed')
  );
}
