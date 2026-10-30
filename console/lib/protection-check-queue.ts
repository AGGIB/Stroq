import { RUN_ERRORS, validateRun, type ControlRun } from './control';
import type { ProtectionEvidenceRow } from './protection-evidence';
import { protectionRunHref } from './protection-check-navigation';
export function protectionEvidenceHref(
  run: ControlRun | undefined,
  runs: readonly ControlRun[],
  workspaceId: string | null,
  stage: 'doctor' | 'policy-check' | 'guard-test',
): string {
  const parent =
    run && runs.find((value) => value.id === run.id && value.kind === 'protection-check');
  if (parent && workspaceId) return protectionRunHref(parent.id, workspaceId, stage);
  if (run && workspaceId)
    return protectionRunHref(run.id, workspaceId).replace(/#.*$/, `#protection-${stage}`);
  return `#protection-${stage}`;
}
export function protectionCheckRows(
  runs: readonly unknown[],
  workspaceId: string | null,
): ProtectionEvidenceRow[] {
  if (!workspaceId || !/^workspace-[a-f0-9]{24}$/.test(workspaceId)) return [];
  const latest = runs
    .filter((run): run is ControlRun => validateRun(run) && run.kind === 'protection-check')
    .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (!latest || !['failed', 'cancelled'].includes(latest.status)) return [];
  return [
    {
      key: 'protection-attempt',
      title:
        latest.status === 'cancelled'
          ? 'Protection check cancelled'
          : 'Protection check incomplete',
      detail: `${latest.progress?.steps.filter((step) => step.status === 'completed').length ?? 0} of 5 checks recorded. ${RUN_ERRORS[latest.error ?? 'engine-failed']}`,
      context: `Recorded ${new Date(latest.finishedAt ?? latest.startedAt).toLocaleString('en-GB')}`,
      href: protectionRunHref(latest.id, workspaceId),
      action: 'Inspect check',
      tone: latest.status === 'cancelled' ? 'muted' : 'orange',
    },
  ];
}

import {
  validateMcpCallControlOverview,
  type McpCallControlOverview,
  type McpCallControlOverviewRow,
} from './mcp-call-control-overview';
const mcpControlHref = (controlId?: string, contextId?: string) =>
  controlId && contextId
    ? `/skills/mcp/?control=${encodeURIComponent(controlId)}&context=${encodeURIComponent(contextId)}`
    : '/skills/mcp/';
function callControlIssue(row: McpCallControlOverviewRow): string | null {
  if (
    ['prepared', 'authority-recorded', 'configuration-unconfirmed'].includes(row.setup) &&
    (row.setupConfiguration !== 'confirmed' || row.current === null)
  )
    return 'setup needs recheck';
  if (row.capability === 'missing-registration')
    return row.current === null
      ? 'call-control authority unavailable'
      : row.current.mode === 'enabled'
        ? 'registration not in this view; call control enabled'
        : null;
  if (row.capability === 'supported') return null;
  if (row.capability === 'drifted') return 'invocation changed';
  if (row.capability === 'ambiguous') return 'control shared by multiple registrations';
  if (row.reason === 'runtime-unavailable') return 'call-control runtime unavailable';
  if (row.capability === 'unsupported') return 'call-control configuration unsupported';
  return row.current === null
    ? 'call-control authority unavailable'
    : 'call-control configuration unavailable';
}
/** Native authority and exact setup evidence stay independent of the inventory review baseline. */
export function mcpCallControlRows(
  state: McpCallControlOverview | null,
  workspaceId: string | null,
): ProtectionEvidenceRow[] {
  if (!workspaceId || !/^workspace-[a-f0-9]{24}$/.test(workspaceId)) return [];
  if (!state || !validateMcpCallControlOverview(state) || state.workspaceId !== workspaceId)
    return [
      {
        key: 'mcp-call-control-unavailable',
        title: 'MCP call-control evidence unavailable',
        detail:
          'The selected local profile could not be checked. No enabled or paused state is inferred.',
        href: mcpControlHref(),
        action: 'Review call control',
        tone: 'orange',
      },
    ];
  const rows: ProtectionEvidenceRow[] = [];
  if (
    state.authority === 'unavailable' ||
    (state.gaps.length > 0 && (state.controls.length > 0 || state.authority === 'ready'))
  ) {
    rows.push({
      key: 'mcp-call-control-authority',
      title:
        state.authority === 'unavailable'
          ? 'MCP call-control authority unavailable'
          : 'MCP call-control coverage needs attention',
      detail:
        state.authority === 'unavailable'
          ? 'The local authority could not be verified. Saved setup and inventory review do not establish a current call decision.'
          : `Checked ${state.checkedAt}. Some fixed registration sources, setup records or runtime files could not be verified.`,
      href: mcpControlHref(),
      action: 'Review call control',
      tone: 'orange',
    });
  }
  for (const row of state.controls) {
    const issue = callControlIssue(row);
    if (!issue) continue;
    const name = row.artifact?.name ?? 'Retained MCP connection';
    rows.push({
      key: `mcp-call-control-${row.controlId}`,
      title: `${name}: ${issue}`,
      detail: `Checked ${state.checkedAt}. Desired state: ${row.current?.mode ?? 'unavailable'}. Call control applies only to new tools/call dispatches through this exact supported proxy. Existing processes, in-flight calls and native-client adoption are outside this observation.`,
      context:
        row.proxyWorkspaceId === workspaceId
          ? 'This workspace'
          : row.proxyWorkspaceId
            ? 'Existing fixed workspace context'
            : 'Workspace context unavailable',
      href: mcpControlHref(row.controlId, state.contextId),
      action: 'Review call control',
      tone: 'orange',
    });
  }
  return rows;
}

import { validateMcpCallControlPreview } from './mcp-call-controls';
import type { CallControlPending } from './mcp-call-control-binding';
import { stamp } from './local-guards';
/** An acknowledged desired state never substitutes for rechecking an unknown operation. */
export function mcpCallControlPendingRows(
  pending: readonly CallControlPending[],
  state: McpCallControlOverview | null,
  workspaceId: string | null,
): ProtectionEvidenceRow[] {
  if (!workspaceId || !/^workspace-[a-f0-9]{24}$/.test(workspaceId)) return [];
  const contextId =
    state && state.workspaceId === workspaceId && validateMcpCallControlOverview(state)
      ? state.contextId
      : null;
  return pending
    .filter(
      (write) =>
        validateMcpCallControlPreview(write.preview) &&
        stamp(write.startedAt) &&
        write.preview.workspaceId === workspaceId,
    )
    .map((write) => {
      const p = write.preview,
        same = contextId === p.contextId,
        foreign = contextId !== null && !same;
      return {
        key: `mcp-call-control-pending-${p.operationId}`,
        title: `${p.artifact.name}: call-control completion unknown`,
        context: same
          ? 'Selected local profile'
          : foreign
            ? 'Different local profile'
            : 'Profile not verified',
        detail: `Requested ${write.startedAt}. Ordinary state reads do not resolve this operation. ${foreign ? 'Switch to the recorded profile before rechecking this exact operation.' : same ? 'Open the recorded control and explicitly recheck this operation.' : 'Verify the recorded local profile before rechecking this exact operation.'}`,
        href: mcpControlHref(p.controlId, p.contextId),
        action: same ? 'Recheck operation' : 'Inspect recorded control',
        tone: 'orange' as const,
      };
    });
}
