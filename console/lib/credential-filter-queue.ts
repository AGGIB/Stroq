import {
  CREDENTIAL_FILTER_REASONS,
  type CredentialFilterRow,
  type CredentialFiltersState,
} from './credential-filters';
import { credentialFilterHref } from './credential-filter-navigation';
import type { ProtectionEvidenceRow } from './protection-evidence';

const configurationLimit =
  'Configuration evidence only; credential exposure and live blocking are not established.';

function label(row: CredentialFilterRow) {
  const agent = row.agent === 'cursor' ? 'Cursor' : 'Claude Code';
  const scope =
    row.context === 'all-workspaces'
      ? 'User · all workspaces'
      : row.context === 'repository'
        ? row.location === 'main-checkout'
          ? 'Repository · main checkout'
          : 'Repository'
        : 'Workspace';
  return `${agent} · ${scope}`;
}

/** Accepts the validated, workspace-bound GET snapshot; never starts an action. */
export function credentialFilterRows(
  state: CredentialFiltersState | null,
  workspaceId: string | null,
): ProtectionEvidenceRow[] {
  const unavailable = {
    key: 'credential-filters-unavailable',
    title: 'Credential file-filter evidence unavailable',
    detail:
      'Current file-filter configuration could not be read in this workspace. No conclusion about credential exposure is available.',
    href: credentialFilterHref(null, workspaceId),
    action: 'Review filters',
    tone: 'orange' as const,
  };
  if (!state || !workspaceId || state.workspaceId !== workspaceId) return [unavailable];
  if (!state.available || state.reason !== null)
    return [
      {
        ...unavailable,
        title: 'Credential file-filter controls unavailable',
        detail: `Checked ${state.generatedAt}. ${state.reason ? CREDENTIAL_FILTER_REASONS[state.reason] : 'Current configuration could not be verified.'} ${configurationLimit}`,
      },
    ];
  return state.targets.flatMap((row): ProtectionEvidenceRow[] => {
    const base = {
      key: `credential-filter-${row.id}`,
      href: credentialFilterHref(row.id, workspaceId),
      action: 'Review filters',
      tone: 'orange' as const,
    };
    if (
      row.reason !== null ||
      row.status === 'unavailable' ||
      row.applications === null ||
      row.managed === null ||
      row.unmanaged === null
    )
      return [
        {
          ...base,
          title: `${label(row)}: filter evidence unverified`,
          detail: `Checked ${state.generatedAt}. ${row.reason ? CREDENTIAL_FILTER_REASONS[row.reason] : 'The source or retained ownership could not be verified.'} ${configurationLimit}`,
        },
      ];
    if (
      row.applications > 0 &&
      row.present < row.required &&
      (row.status === 'partial' || row.status === 'absent')
    )
      return [
        {
          ...base,
          title: `${label(row)}: recorded filter setup incomplete`,
          // Manifest records describe intent before source replacement. They do not
          // prove a successful earlier apply, or who removed a currently absent rule.
          detail: `Checked ${state.generatedAt}. ${row.present}/${row.required} explicit rules present; ${row.applications} recorded application${row.applications === 1 ? '' : 's'}. ${configurationLimit}`,
        },
      ];
    return [];
  });
}
