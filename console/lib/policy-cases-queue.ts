import type { PolicyCasesState } from './policy-cases';
import type { ProtectionEvidenceRow } from './protection-evidence';

/** Projects only a validated current-workspace simulation; never starts a host or changes a case. */
export function policyCaseRows(
  state: PolicyCasesState | null,
  workspaceId: string | null,
): ProtectionEvidenceRow[] {
  const unavailable: ProtectionEvidenceRow = {
    key: 'policy-cases-unavailable',
    title: 'Saved policy-check evidence unavailable',
    detail:
      'Saved expectations could not be checked against the current policy. No current passing result is available.',
    href: '/policies/checks/',
    action: 'Review checks',
    tone: 'orange',
  };
  if (!state || !workspaceId || state.workspaceId !== workspaceId) return [unavailable];
  if (state.report.failed === 0) return [];
  return [
    {
      key: 'policy-cases-failed',
      title: `${state.report.failed} of ${state.report.total} saved policy checks need review`,
      detail: `Checked ${state.generatedAt}. ${state.report.total} saved ${state.report.total === 1 ? 'check' : 'checks'} · 2 session contexts per check. Expected decisions do not match the current policy. This is local policy simulation; live blocking is not established.`,
      href: '/policies/checks/',
      action: 'Review checks',
      tone: 'orange',
    },
  ];
}
