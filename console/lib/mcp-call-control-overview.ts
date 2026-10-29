import { closed, hash, member, stamp } from './local-guards';
import { validateMcpContainmentArtifact, type McpContainmentArtifact } from './mcp-containment';
import type { McpCallControlCurrent, McpCallControlInspection } from './mcp-call-controls';

export interface McpCallControlOverviewRow {
  controlId: string;
  artifact: McpContainmentArtifact | null;
  retainedSetupId: string | null;
  proxyWorkspaceId: string | null;
  invocationSha256: string | null;
  capability: McpCallControlInspection['capability'] | 'missing-registration';
  reason: McpCallControlInspection['reason'];
  current: McpCallControlCurrent | null;
  observation: McpCallControlInspection['observation'];
  setup:
    | 'none'
    | 'prepared'
    | 'authority-recorded'
    | 'configuration-confirmed'
    | 'configuration-unconfirmed';
  setupConfiguration: 'confirmed' | 'unconfirmed' | 'unavailable' | null;
  setupCandidate: {
    operationId: string;
    artifact: McpContainmentArtifact;
    invocationSha256: string;
  } | null;
}
export interface McpCallControlOverview {
  schema: 'stroq-mcp-call-controls/1';
  workspaceId: string;
  contextId: string;
  checkedAt: string;
  authority: 'ready' | 'missing' | 'unavailable';
  revision: string | null;
  gaps: ('source-unavailable' | 'source-limit' | 'runtime-unavailable' | 'setup-unavailable')[];
  controls: McpCallControlOverviewRow[];
  hostEnforcement: false;
}
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  closed(v, keys) && Reflect.ownKeys(v).length === keys.length;
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const workspace = (v: unknown) => typeof v === 'string' && /^workspace-[a-f0-9]{24}$/.test(v);
const observation = (v: unknown, current: McpCallControlCurrent | null) => {
  if (!exact(v, ['status', 'at', 'eventId', 'invocationSha256', 'reason'])) return false;
  if (v.status === 'unobserved' || v.status === 'unavailable')
    return v.at === null && v.eventId === null && v.invocationSha256 === null && v.reason === null;
  return (
    v.status === 'observed' &&
    current !== null &&
    stamp(v.at) &&
    v.eventId === current.eventId &&
    v.invocationSha256 === current.invocationSha256 &&
    member(v.reason, ['paused', 'busy', 'unavailable']) &&
    Date.parse(v.at as string) >= Date.parse(current.at) &&
    (v.reason !== 'paused' || current.mode === 'paused')
  );
};
function row(v: unknown): v is McpCallControlOverviewRow {
  if (
    !exact(v, [
      'controlId',
      'artifact',
      'retainedSetupId',
      'proxyWorkspaceId',
      'invocationSha256',
      'capability',
      'reason',
      'current',
      'observation',
      'setup',
      'setupConfiguration',
      'setupCandidate',
    ]) ||
    !uuid(v.controlId) ||
    (v.artifact !== null && !validateMcpContainmentArtifact(v.artifact)) ||
    (v.retainedSetupId !== null && !uuid(v.retainedSetupId)) ||
    (v.proxyWorkspaceId !== null && !workspace(v.proxyWorkspaceId)) ||
    (v.invocationSha256 !== null && !hash(v.invocationSha256)) ||
    !member(v.capability, [
      'setup-required',
      'supported',
      'drifted',
      'ambiguous',
      'unsupported',
      'unavailable',
      'missing-registration',
    ]) ||
    !(
      v.reason === null ||
      member(v.reason, [
        'unsupported-wrapper',
        'context-unavailable',
        'source-unavailable',
        'source-limit',
        'duplicate-control',
        'storage-unavailable',
        'runtime-unavailable',
        'invocation-drift',
      ])
    ) ||
    !member(v.setup, [
      'none',
      'prepared',
      'authority-recorded',
      'configuration-confirmed',
      'configuration-unconfirmed',
    ])
  )
    return false;
  if (
    v.setup === 'none'
      ? v.setupConfiguration !== null || v.setupCandidate !== null
      : !member(v.setupConfiguration, ['confirmed', 'unconfirmed', 'unavailable'])
  )
    return false;
  if (
    v.setupCandidate !== null &&
    (!exact(v.setupCandidate, ['operationId', 'artifact', 'invocationSha256']) ||
      !uuid(v.setupCandidate.operationId) ||
      v.setupCandidate.operationId !== v.retainedSetupId ||
      !validateMcpContainmentArtifact(v.setupCandidate.artifact) ||
      !hash(v.setupCandidate.invocationSha256))
  )
    return false;
  if (
    v.current !== null &&
    (!exact(v.current, ['controlId', 'invocationSha256', 'mode', 'eventId', 'at']) ||
      v.current.controlId !== v.controlId ||
      !hash(v.current.invocationSha256) ||
      !member(v.current.mode, ['paused', 'enabled']) ||
      !uuid(v.current.eventId) ||
      !stamp(v.current.at))
  )
    return false;
  if (!observation(v.observation, v.current as McpCallControlCurrent | null)) return false;
  if (
    v.capability === 'supported' &&
    (v.current === null ||
      v.current.invocationSha256 !== v.invocationSha256 ||
      v.artifact === null ||
      v.proxyWorkspaceId === null ||
      v.reason !== null)
  )
    return false;
  return !(v.capability === 'missing-registration' && v.reason !== null);
}
export function validateMcpCallControlOverview(v: unknown): v is McpCallControlOverview {
  if (
    !exact(v, [
      'schema',
      'workspaceId',
      'contextId',
      'checkedAt',
      'authority',
      'revision',
      'gaps',
      'controls',
      'hostEnforcement',
    ]) ||
    v.schema !== 'stroq-mcp-call-controls/1' ||
    !workspace(v.workspaceId) ||
    typeof v.contextId !== 'string' ||
    !/^context-[a-f0-9]{64}$/.test(v.contextId) ||
    !stamp(v.checkedAt) ||
    !member(v.authority, ['ready', 'missing', 'unavailable']) ||
    (v.authority === 'ready' ? !hash(v.revision) : v.revision !== null) ||
    v.hostEnforcement !== false ||
    !Array.isArray(v.gaps) ||
    v.gaps.length > 4 ||
    new Set(v.gaps).size !== v.gaps.length ||
    !v.gaps.every((g) =>
      member(g, ['source-unavailable', 'source-limit', 'runtime-unavailable', 'setup-unavailable']),
    ) ||
    !Array.isArray(v.controls) ||
    v.controls.length > 224 ||
    !v.controls.every(row) ||
    new Set(v.controls.map((c) => c.controlId)).size !== v.controls.length
  )
    return false;
  return v.authority === 'ready' || v.controls.every((c) => c.current === null);
}
