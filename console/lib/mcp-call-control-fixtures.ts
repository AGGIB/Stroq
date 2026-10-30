import type {
  McpCallControlInspection,
  McpCallControlPreview,
  McpCallControlReceipt,
  McpCallControlRecheck,
} from './mcp-call-controls';
import type { McpCallControlOverview } from './mcp-call-control-overview';
export const callWorkspace = 'workspace-' + 'a'.repeat(24),
  callContext = 'context-' + 'b'.repeat(64);
export const callUuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const callArtifact = {
  id: 'item-' + 'c'.repeat(24),
  kind: 'mcp',
  name: 'Notes',
  agent: 'cursor',
  scope: 'project',
  sha256: 'd'.repeat(64),
  digestFormat: 'mcp-entry-canonical-json/1',
  configSource: 'cursor-project',
} as const;
export function callInspection(): McpCallControlInspection {
  return {
    schema: 'stroq-mcp-call-control/1',
    workspaceId: callWorkspace,
    proxyWorkspaceId: callWorkspace,
    contextId: callContext,
    checkedAt: '2026-10-24T10:00:00.000Z',
    artifact: callArtifact,
    capability: 'supported',
    reason: null,
    configuration: 'controlled',
    modes: { strict: true, toolApproval: false, cloak: false, pinned: false },
    controlId: callUuid(1),
    invocationSha256: 'e'.repeat(64),
    revision: 'f'.repeat(64),
    current: {
      controlId: callUuid(1),
      invocationSha256: 'e'.repeat(64),
      mode: 'enabled',
      eventId: callUuid(2),
      at: '2026-10-24T09:00:00.000Z',
    },
    observation: {
      status: 'unobserved',
      at: null,
      eventId: null,
      invocationSha256: null,
      reason: null,
    },
    hostEnforcement: false,
  };
}
export function callPreview(
  action: McpCallControlPreview['action'] = 'pause',
): McpCallControlPreview {
  const i = callInspection();
  return {
    schema: 'stroq-mcp-call-control-preview/1',
    id: callUuid(3),
    operationId: callUuid(4),
    createdAt: '2026-10-24T10:00:00.000Z',
    expiresAt: '2026-10-24T10:02:00.000Z',
    workspaceId: callWorkspace,
    proxyWorkspaceId: callWorkspace,
    contextId: callContext,
    action,
    artifact: callArtifact,
    controlId: callUuid(1),
    invocationSha256: i.invocationSha256!,
    expectedRevision: i.revision,
    expectedEventId: action === 'setup' ? null : i.current!.eventId,
    changesConfiguration: action === 'setup',
    requiresReconnect: action === 'setup',
    sharedUserScope: false,
    retention: {
      maxControls: 64,
      maxEvents: 512,
      maxBytes: 1048576,
      setupMaxRecords: 32,
      setupMaxBytes: 17825792,
    },
    hostEnforcement: false,
  };
}
export function callReceipt(p = callPreview()): McpCallControlReceipt {
  return {
    schema: 'stroq-mcp-call-control-receipt/1',
    previewId: p.id,
    operationId: p.operationId,
    workspaceId: p.workspaceId,
    proxyWorkspaceId: p.proxyWorkspaceId,
    contextId: p.contextId,
    action: p.action,
    artifact: p.artifact,
    controlId: p.controlId,
    invocationSha256: p.invocationSha256,
    expectedEventId: p.expectedEventId,
    completedAt: '2026-10-24T10:00:01.000Z',
    authority: 'confirmed',
    configuration: p.action === 'setup' ? 'confirmed' : 'unchanged',
    revision: '1'.repeat(64),
    eventId: p.operationId,
    requiresReconnect: p.requiresReconnect,
    hostEnforcement: false,
  };
}
export function callRecheck(p = callPreview()): McpCallControlRecheck {
  return {
    schema: 'stroq-mcp-call-control-recheck/1',
    checkedAt: '2026-10-24T10:00:02.000Z',
    workspaceId: p.workspaceId,
    contextId: p.contextId,
    operationId: p.operationId,
    action: p.action,
    controlId: p.controlId,
    invocationSha256: p.invocationSha256,
    authority: 'recorded',
    recordedEventId: p.operationId,
    configuration: p.action === 'setup' ? 'confirmed' : 'unchanged',
    currentEventId: p.operationId,
    currentMode: p.action === 'resume' ? 'enabled' : 'paused',
    hostEnforcement: false,
  };
}
export function callOverview(): McpCallControlOverview {
  const i = callInspection();
  return {
    schema: 'stroq-mcp-call-controls/1',
    workspaceId: callWorkspace,
    contextId: callContext,
    checkedAt: i.checkedAt,
    authority: 'ready',
    revision: i.revision,
    gaps: [],
    controls: [
      {
        controlId: i.controlId!,
        artifact: i.artifact,
        retainedSetupId: callUuid(7),
        proxyWorkspaceId: i.proxyWorkspaceId,
        invocationSha256: i.invocationSha256,
        capability: 'missing-registration',
        reason: null,
        current: i.current,
        observation: i.observation,
        setup: 'configuration-confirmed',
        setupCandidate: null,
        setupConfiguration: 'unconfirmed',
      },
    ],
    hostEnforcement: false,
  };
}
