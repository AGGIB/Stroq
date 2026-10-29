import { closed, count, hash, member, stamp, text } from './local-guards';
import {
  MCP_GOVERNANCE_CHANNELS,
  type McpGovernancePairSummary,
  type McpGovernanceCurrent,
  type McpGovernanceDiff,
  type McpGovernanceRestoreDiff,
} from './mcp-governance-types';
export const exact = (v: unknown, keys: string[]): v is Record<string, any> =>
  closed(v, keys) && Reflect.ownKeys(v).length === keys.length;
export const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
export const context = (v: unknown): v is string =>
  typeof v === 'string' && /^governance-context-[a-f0-9]{64}$/.test(v);
export const workspace = (v: unknown): v is string =>
  typeof v === 'string' && /^workspace-[a-f0-9]{24}$/.test(v);
export const choiceId = (v: unknown): v is string =>
  typeof v === 'string' && /^choice-[a-f0-9]{64}$/.test(v);
export const nullableHash = (v: unknown) => v === null || hash(v);
export const unique = <T>(values: T[], key: (v: T) => string) =>
  new Set(values.map(key)).size === values.length;
export const pairKey = (v: McpGovernancePairSummary) => v.channel + ':' + v.identitySha256;
export const samePairs = (a: McpGovernancePairSummary[], b: McpGovernancePairSummary[]) =>
  a.length === b.length && a.every((p) => b.some((q) => pairKey(p) === pairKey(q)));
export function validateMcpGovernancePairSummary(v: unknown): v is McpGovernancePairSummary {
  return (
    exact(v, ['channel', 'label', 'redacted', 'identitySha256']) &&
    member(v.channel, MCP_GOVERNANCE_CHANNELS) &&
    text(v.label, 200) &&
    typeof v.redacted === 'boolean' &&
    hash(v.identitySha256)
  );
}
export const pairs = (v: unknown): v is McpGovernancePairSummary[] =>
  Array.isArray(v) &&
  v.length <= 64 &&
  v.every(validateMcpGovernancePairSummary) &&
  unique(v, pairKey);
export function validateMcpGovernanceCurrent(v: unknown): v is McpGovernanceCurrent {
  return (
    exact(v, ['policyVersion', 'gate', 'allowed']) &&
    [null, 1, 2].includes(v.policyVersion) &&
    member(v.gate, ['absent', 'enforced', 'unavailable']) &&
    pairs(v.allowed) &&
    (v.gate === 'enforced'
      ? v.policyVersion === 2
      : v.gate === 'absent'
        ? v.policyVersion === 1 && v.allowed.length === 0
        : v.allowed.length === 0)
  );
}
export function validateMcpGovernanceDiff(v: unknown): v is McpGovernanceDiff {
  return (
    exact(v, ['added', 'removed', 'retained']) &&
    pairs(v.added) &&
    pairs(v.removed) &&
    pairs(v.retained) &&
    v.added.length + v.retained.length <= 64 &&
    v.removed.length + v.retained.length <= 64 &&
    unique([...v.added, ...v.removed, ...v.retained], pairKey)
  );
}
export function validateMcpGovernanceRestoreDiff(v: unknown): v is McpGovernanceRestoreDiff {
  return (
    exact(v, [
      'current',
      'candidate',
      'diff',
      'selectedEffect',
      'registrationPinned',
      'hostEnforcement',
    ]) &&
    validateMcpGovernanceCurrent(v.current) &&
    validateMcpGovernanceCurrent(v.candidate) &&
    v.current.gate !== 'unavailable' &&
    v.candidate.gate !== 'unavailable' &&
    validateMcpGovernanceDiff(v.diff) &&
    samePairs(v.current.allowed, [...v.diff.removed, ...v.diff.retained]) &&
    samePairs(v.candidate.allowed, [...v.diff.added, ...v.diff.retained]) &&
    v.selectedEffect === 'continue-existing-checks' &&
    v.registrationPinned === false &&
    v.hostEnforcement === false
  );
}
const severities: Record<string, readonly string[]> = {
  'shadowed-rule': ['warning'],
  'dropped-protection': ['error', 'warning'],
  'high-threshold': ['warning'],
  'loose-default': ['info'],
  'unknown-field': ['warning'],
};
export function governanceCheck(v: unknown) {
  return (
    exact(v, ['ok', 'loaded', 'faults', 'findings']) &&
    typeof v.ok === 'boolean' &&
    typeof v.loaded === 'boolean' &&
    count(v.faults) &&
    Array.isArray(v.findings) &&
    v.findings.length <= 64 &&
    v.findings.every(
      (r: unknown) =>
        exact(r, ['kind', 'severity', 'count']) &&
        typeof r.kind === 'string' &&
        Object.hasOwn(severities, r.kind) &&
        member(r.severity, severities[r.kind]!) &&
        count(r.count) &&
        r.count > 0,
    ) &&
    unique(v.findings, (r: any) => r.kind + ':' + r.severity) &&
    v.ok === (v.loaded && v.faults === 0 && v.findings.every((r: any) => r.severity === 'info'))
  );
}
export function governanceSimulation(v: unknown) {
  return (
    exact(v, [
      'ok',
      'replayed',
      'attacksPassing',
      'newInterruptions',
      'relieved',
      'violations',
      'notJudged',
    ]) &&
    typeof v.ok === 'boolean' &&
    exact(v.replayed, ['attack', 'ordinary', 'cases']) &&
    count(v.replayed.attack) &&
    count(v.replayed.ordinary) &&
    v.replayed.cases === 0 &&
    ['attacksPassing', 'newInterruptions', 'relieved', 'violations', 'notJudged'].every((k) =>
      count(v[k]),
    ) &&
    v.ok === (v.attacksPassing === 0 && v.violations === 0 && v.notJudged === 0)
  );
}
export { count, hash, member, stamp, text };
