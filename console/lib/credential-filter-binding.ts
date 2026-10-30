import type {
  CredentialFilterAction,
  CredentialFilterContext,
  CredentialFilterLocation,
  CredentialFilterPreview,
  CredentialFilterReceipt,
  CredentialFilterTarget,
} from './credential-filters';
export type CredentialFilterSelectionTarget = CredentialFilterTarget;
const CLAUDE_PATTERNS = [
  'Read(./.env)',
  'Read(./.env.*)',
  'Read(~/.ssh/**)',
  'Read(~/.aws/**)',
  'Read(~/.config/gcloud/**)',
  'Read(~/.config/gh/hosts.yml)',
  'Read(~/.kube/**)',
  'Read(~/.docker/config.json)',
  'Read(~/.npmrc)',
  'Read(~/.netrc)',
  'Read(~/.pgpass)',
  'Read(~/.git-credentials)',
  'Read(~/.gnupg/**)',
] as const;
export const CREDENTIAL_FILTER_PATTERNS = {
  'claude-project': CLAUDE_PATTERNS,
  'claude-user': CLAUDE_PATTERNS,
  'cursor-project': ['.env', '.env.*'],
} as const;

export function credentialFilterTarget(
  agent: string,
  scope: 'project' | 'user',
): CredentialFilterSelectionTarget | null {
  if (agent === 'claude-code') return scope === 'project' ? 'claude-project' : 'claude-user';
  return agent === 'cursor' && scope === 'project' ? 'cursor-project' : null;
}

export function credentialFilterContextKey(
  workspaceId: string | null,
  target: CredentialFilterSelectionTarget | null,
  generation: number,
) {
  if (
    workspaceId === null ||
    !/^workspace-[a-f0-9]{24}$/.test(workspaceId) ||
    target === null ||
    !Number.isSafeInteger(generation) ||
    generation < 0
  )
    return null;
  return `${workspaceId}:${target}:${generation}`;
}

export interface CredentialFilterSelection {
  workspaceId: string;
  target: CredentialFilterTarget;
  action: CredentialFilterAction;
  location: CredentialFilterLocation;
  context: CredentialFilterContext;
}
export function credentialFilterPreviewMatches(
  preview: CredentialFilterPreview,
  selected: CredentialFilterSelection,
) {
  return (
    preview.workspaceId === selected.workspaceId &&
    preview.target === selected.target &&
    preview.action === selected.action &&
    preview.location === selected.location &&
    preview.context === selected.context
  );
}
export function credentialFilterReceiptMatches(
  receipt: CredentialFilterReceipt,
  preview: CredentialFilterPreview,
) {
  const applications =
    preview.action === 'undo-filter'
      ? preview.applications
      : preview.operation === 'unchanged'
        ? 0
        : 1;
  const statusMatches =
    preview.operation === 'unchanged'
      ? receipt.status === 'unchanged'
      : preview.action === 'apply-filter'
        ? receipt.status === 'configured'
        : receipt.status === 'undone' ||
          (preview.operation === 'clear-history' && receipt.status === 'unchanged');
  return (
    statusMatches &&
    receipt.previewId === preview.id &&
    receipt.workspaceId === preview.workspaceId &&
    receipt.target === preview.target &&
    receipt.action === preview.action &&
    receipt.backup === preview.backup &&
    receipt.applications === applications &&
    receipt.candidateSha256 === preview.candidateSha256
  );
}
export interface CredentialFilterAcknowledgements {
  acknowledgeNativeLimits: boolean;
  acknowledgePrivateRetention: boolean;
  acknowledgeWeakenFilter: boolean;
  acknowledgeReformat: boolean;
  acknowledgeLink: boolean;
  acknowledgeCredentialLoss: boolean;
  acknowledgeSharedScope: boolean;
}
export function emptyCredentialFilterAcknowledgements(): CredentialFilterAcknowledgements {
  return {
    acknowledgeNativeLimits: false,
    acknowledgePrivateRetention: false,
    acknowledgeWeakenFilter: false,
    acknowledgeReformat: false,
    acknowledgeLink: false,
    acknowledgeCredentialLoss: false,
    acknowledgeSharedScope: false,
  };
}
export function credentialFilterApplyInput(
  preview: CredentialFilterPreview,
  acknowledged: CredentialFilterAcknowledgements,
) {
  if (
    !acknowledged.acknowledgeNativeLimits ||
    !acknowledged.acknowledgePrivateRetention ||
    (preview.action === 'undo-filter' && !acknowledged.acknowledgeWeakenFilter)
  )
    return null;
  for (const key of Object.keys(preview.needs) as (keyof CredentialFilterPreview['needs'])[])
    if (preview.needs[key] && !acknowledged[key]) return null;
  return {
    previewId: preview.id,
    confirm: true,
    acknowledgeNativeLimits: true,
    acknowledgePrivateRetention: true,
    ...(preview.action === 'undo-filter' ? { acknowledgeWeakenFilter: true } : {}),
    ...Object.fromEntries(
      Object.entries(preview.needs)
        .filter(([, needed]) => needed)
        .map(([key]) => [key, true]),
    ),
  };
}
