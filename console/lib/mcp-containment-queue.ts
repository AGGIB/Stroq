import type { McpContainmentState } from './mcp-containment';
import { mcpContainmentHref } from './mcp-containment-navigation';
import type { ProtectionEvidenceRow } from './protection-evidence';

/** Configuration/recovery observations only; an absent registration is not host enforcement. */
export function mcpContainmentRows(
  state: McpContainmentState | null,
  workspaceId: string | null,
): ProtectionEvidenceRow[] {
  const href = mcpContainmentHref(null, null, 'attention');
  if (!state || state.workspaceId !== workspaceId)
    return [
      {
        key: 'mcp-recovery-unavailable',
        title: 'MCP recovery evidence unavailable',
        detail: 'Retained configuration operations could not be rechecked in this workspace.',
        href,
        action: 'Inspect recovery',
        tone: 'orange',
      },
    ];
  const rows: ProtectionEvidenceRow[] = [];
  if (state.gaps.length || !state.available)
    rows.push({
      key: 'mcp-recovery-storage',
      title:
        state.reason === 'storage-unavailable' || state.gaps.length
          ? 'MCP recovery storage needs attention'
          : 'MCP configuration actions unavailable',
      detail:
        'Read the retained evidence before preparing another configuration change. Existing backups are preserved.',
      href,
      action: 'Inspect recovery',
      tone: 'orange',
    });
  for (const record of state.records) {
    if (record.artifact.scope === 'project' && record.originWorkspaceId !== workspaceId) continue;
    if (record.status === 'removed' || record.status === 'restored') continue;
    if (record.status === 'configured' && record.proxy?.runtimeMatches === true) continue;
    const label =
      record.status === 'configured'
        ? record.proxy?.runtimeMatches === false
          ? 'proxy runtime changed'
          : 'proxy runtime unverified'
        : record.status === 'reappeared'
          ? 'registration reappeared'
          : record.status === 'recovery-required'
            ? 'configuration operation needs recovery'
            : record.status === 'config-missing'
              ? 'configuration source missing'
              : record.status === 'changed'
                ? 'configuration or recovery files changed'
                : 'configuration evidence unverified';
    rows.push({
      key: `mcp-recovery-${record.id}`,
      title: `${record.artifact.name}: ${label}`,
      detail: `Rechecked ${record.checkedAt}. One configuration source; already connected servers and other registrations are outside this observation.`,
      href: mcpContainmentHref(record.id, workspaceId),
      action: 'Inspect record',
      tone: 'orange',
    });
  }
  return rows;
}
