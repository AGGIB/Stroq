import { parseDocument, stringify } from 'yaml';
import { DEFAULT_POLICY } from '../../packages/core/src/policy/default-policy.js';
import {
  PolicySchema,
  McpGovernanceSchema,
  type Policy,
} from '../../packages/core/src/policy/policy-types.js';
import { evaluatePolicy } from '../../packages/core/src/policy/evaluate.js';
import { evaluateMcpGovernance } from '../../packages/core/src/policy/mcp-governance.js';
import { ACTION_CLASSES } from '../../packages/core/src/types.js';
import { policySha256 } from '../../packages/cli/src/policy/digest.js';
import { readYaml } from '../../packages/cli/src/policy/yaml.js';
import { unknownFieldPaths } from '../../packages/cli/src/policy/unknown-fields.js';
import type { McpGovernanceGateChecks } from '../lib/mcp-governance-types';
import { governanceHash, type GovernancePair } from './mcp-governance-capture-policy';
import {
  governanceAllowed,
  governanceCurrent,
  governanceDiff,
  withoutGovernance,
} from './mcp-governance-policy-shape';
export { mcpGovernanceRestoreDiff } from './mcp-governance-policy-shape';

function documentFor(text: string | null) {
  if (!(text === null || (typeof text === 'string' && Buffer.byteLength(text) <= 256 * 1024)))
    throw Error('policy-invalid');
  const document = parseDocument(text ?? stringify(DEFAULT_POLICY));
  if (document.errors.length) throw Error('policy-invalid');
  try {
    document.toJS({ maxAliasCount: 0 });
  } catch {
    throw Error('policy-invalid');
  }
  return document;
}
export function readGovernancePolicy(text: string | null): Policy {
  documentFor(text);
  const yaml = text === null ? { ok: true as const, value: DEFAULT_POLICY } : readYaml(text);
  if (!yaml.ok || unknownFieldPaths(yaml.value).length) throw Error('policy-invalid');
  const result = PolicySchema.safeParse(yaml.value);
  if (!result.success || result.data.rules.length > 512) throw Error('policy-invalid');
  return result.data;
}
export function inspectMcpGovernancePolicy(text: string | null) {
  const policy = readGovernancePolicy(text);
  return {
    current: governanceCurrent(policy),
    allowed: governanceAllowed(policy),
    policyFingerprint: policySha256(policy),
  };
}
/** The pairs are derived by the server from opaque captured selections. Never call with browser labels. */
export function buildMcpGovernancePolicy(text: string | null, pairs: readonly GovernancePair[]) {
  const parsed = McpGovernanceSchema.safeParse({ allowed: pairs });
  if (!parsed.success) throw Error('invalid-request');
  const current = readGovernancePolicy(text),
    allowed = parsed.data.allowed;
  const diff = governanceDiff(governanceAllowed(current), allowed);
  if (current.version === 2 && !diff.added.length && !diff.removed.length)
    throw Error('no-changes');
  const document = documentFor(text);
  document.set('version', 2);
  document.set('mcpGovernance', { allowed });
  const candidateText = document.toString(),
    policy = readGovernancePolicy(candidateText);
  const expected = { ...current, version: 2, mcpGovernance: { allowed } };
  if (policySha256(policy) !== policySha256(PolicySchema.parse(expected)))
    throw Error('policy-invalid');
  return {
    candidateText,
    policy,
    current: governanceCurrent(current),
    diff,
    requiresWeakening: current.version === 2 && diff.added.length > 0,
  };
}
/** Fixed core fixtures: no model, host-client, endpoint authentication or source-coverage claim. */
export function checkMcpGovernanceGate(
  policy: Policy,
  runtimeSha256: string,
): McpGovernanceGateChecks {
  if (policy.version !== 2 || !/^[a-f0-9]{64}$/.test(runtimeSha256)) throw Error('invalid-request');
  const base = withoutGovernance(policy),
    selected = policy.mcpGovernance.allowed[0];
  const classes = ['mcp.call', 'mcp.side_effect'] as const;
  const listed = selected ? { mcpIdentity: { kind: 'server' as const, ...selected } } : undefined;
  const listedPass =
    listed &&
    evaluateMcpGovernance(policy, classes, listed) === null &&
    (['none', 'suspect'] as const).every(
      (t) =>
        governanceHash(evaluatePolicy(policy, [...classes], t === 'none' ? null : t, listed)) ===
        governanceHash(evaluatePolicy(base, [...classes], t === 'none' ? null : t)),
    );
  let name = 'stroq-unlisted-fixture';
  while (policy.mcpGovernance.allowed.some((p) => p.channel === 'mcp-proxy' && p.name === name))
    name += '-x';
  const unlisted = evaluatePolicy(policy, ['mcp.call'], null, {
    mcpIdentity: { kind: 'server', channel: 'mcp-proxy', name },
  });
  const unknown = evaluatePolicy(policy, ['mcp.call'], null);
  const unchanged = ACTION_CLASSES.filter((c) => !c.startsWith('mcp.')).every((c) =>
    (['none', 'suspect'] as const).every(
      (t) =>
        governanceHash(evaluatePolicy(policy, [c], t === 'none' ? null : t)) ===
        governanceHash(evaluatePolicy(base, [c], t === 'none' ? null : t)),
    ),
  );
  const cases: McpGovernanceGateChecks['cases'] = [
    {
      id: 'listed-continues',
      status: !selected ? 'not-applicable' : listedPass ? 'passed' : 'failed',
    },
    {
      id: 'unlisted-denied',
      status:
        unlisted.effect === 'deny' && unlisted.ruleId === 'mcp-governance-unlisted'
          ? 'passed'
          : 'failed',
    },
    {
      id: 'unknown-denied',
      status:
        unknown.effect === 'deny' && unknown.ruleId === 'mcp-governance-identity-unknown'
          ? 'passed'
          : 'failed',
    },
    { id: 'non-mcp-unchanged', status: unchanged ? 'passed' : 'failed' },
  ];
  return {
    scope: 'core-mcp-gate-fixtures',
    runtimeSha256,
    passed: cases.every((c) => c.status === 'passed' || c.status === 'not-applicable'),
    cases,
    modelCalls: 0,
    providerCalls: 0,
  };
}

export async function previewMcpGovernancePolicy(
  text: string | null,
  changes: unknown,
  records: unknown,
  caseRevision: string | null,
) {
  if (
    !changes ||
    typeof changes !== 'object' ||
    Array.isArray(changes) ||
    Reflect.ownKeys(changes).length !== 2 ||
    !Object.hasOwn(changes, 'allowed') ||
    !Object.hasOwn(changes, 'runtimeSha256')
  )
    throw Error('invalid-request');
  const input = changes as { allowed: GovernancePair[]; runtimeSha256: string };
  const built = buildMcpGovernancePolicy(text, input.allowed);
  const { previewPolicyRestore } = await import('./policy-engine-entry');
  const prepared = await previewPolicyRestore(
    text,
    { candidateText: built.candidateText },
    records,
    caseRevision,
  );
  return {
    ...prepared,
    current: built.current,
    diff: built.diff,
    requiresWeakening: built.requiresWeakening,
    gateChecks: checkMcpGovernanceGate(built.policy, input.runtimeSha256),
  };
}
