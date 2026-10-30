import type { IncidentComparison } from './incident-comparison';
import type { PolicyCase, PolicyCaseReceipt, PolicyCasesState } from './policy-cases';

export function capturedStoreMatchesComparison(
  state: PolicyCasesState,
  comparison: IncidentComparison,
  workspaceId: string,
) {
  return (
    state.workspaceId === workspaceId &&
    state.report.policy.semanticSha === comparison.currentPolicy.semanticSha &&
    state.report.policy.rawSha === comparison.currentPolicy.rawSha &&
    state.report.policy.source === comparison.currentPolicy.source
  );
}

export function caseMatchesComparison(record: PolicyCase, comparison: IncidentComparison) {
  return (
    comparison.classes.length > 0 &&
    record.expected.length === 2 &&
    JSON.stringify(record.classes) === JSON.stringify([...comparison.classes].sort()) &&
    record.expected.every(
      (item, index) =>
        item.taint === comparison.scenarios[index]?.taint &&
        item.effect === comparison.scenarios[index]?.effect,
    )
  );
}

export function saveReceiptMatches(
  receipt: PolicyCaseReceipt,
  comparison: IncidentComparison,
  workspaceId: string,
) {
  return (
    ['saved', 'unchanged'].includes(receipt.status) &&
    receipt.workspaceId === workspaceId &&
    receipt.record !== null &&
    receipt.record.id === receipt.caseId &&
    caseMatchesComparison(receipt.record, comparison) &&
    (receipt.status === 'unchanged' ||
      (receipt.record.source.incidentId === comparison.incidentId &&
        receipt.record.source.evidenceSha === comparison.evidenceSha &&
        receipt.record.source.workspaceId === workspaceId))
  );
}

export function removedReceiptMatches(
  receipt: PolicyCaseReceipt,
  caseId: string,
  workspaceId: string,
) {
  return (
    receipt.status === 'removed' &&
    receipt.caseId === caseId &&
    receipt.workspaceId === workspaceId &&
    receipt.record === null
  );
}
