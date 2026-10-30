'use client';
import { useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import type { IncidentComparison } from '@/lib/incident-comparison';
import {
  validatePolicyCaseReceipt,
  type PolicyCase,
  type PolicyCaseReceipt,
  type PolicyCasesState,
} from '@/lib/policy-cases';
import {
  capturedStoreMatchesComparison,
  caseMatchesComparison,
  removedReceiptMatches,
  saveReceiptMatches,
} from '@/lib/policy-case-binding';
import { usePolicyCases } from './use-policy-cases';

export function usePolicyCaseAction({
  open,
  comparison = null,
  record = null,
  onCompleted,
}: {
  open: boolean;
  comparison?: IncidentComparison | null;
  record?: PolicyCase | null;
  onCompleted?: () => void;
}) {
  const { requestLocal } = usePlatform();
  const mode = comparison ? 'save' : 'remove';
  const context = comparison ? JSON.stringify(comparison) : JSON.stringify(record);
  const read = usePolicyCases(open, `${mode}:${context}`);
  const key =
    open && read.workspaceId ? `${read.workspaceId}:${mode}:${context}:${read.generation}` : null;
  const currentKey = useRef(key);
  currentKey.current = key;
  const active = useRef<{
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [progress, setProgress] = useState<{ key: string; busy: boolean } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string; unknown: boolean } | null>(
    null,
  );
  const [completed, setCompleted] = useState<{ key: string; receipt: PolicyCaseReceipt } | null>(
    null,
  );
  const [message, setMessage] = useState<{ state: PolicyCasesState; value: string } | null>(null);
  const consentKey = key && read.state ? `${key}:${read.state.revision}` : null;
  const [consent, setConsent] = useState<{ key: string; shared: boolean; weaken: boolean } | null>(
    null,
  );
  const ack = consent?.key === consentKey ? consent : { shared: false, weaken: false };
  const busy = progress?.key === key && progress.busy;
  const error = failure?.key === key ? failure : null;
  const receipt = completed?.key === key ? completed.receipt : null;
  const policyMatches = Boolean(
    comparison &&
    read.state &&
    read.workspaceId &&
    capturedStoreMatchesComparison(read.state, comparison, read.workspaceId),
  );
  const selected = record && read.state?.cases.find((item) => item.id === record.id);
  const selectionMatches = Boolean(selected && JSON.stringify(selected) === JSON.stringify(record));
  useEffect(
    () => () => {
      active.current?.controller.abort();
      if (active.current) clearTimeout(active.current.timer);
      active.current = null;
    },
    [key, requestLocal],
  );
  const acknowledge = (flag: 'shared' | 'weaken', value: boolean) => {
    if (!consentKey || busy || receipt) return;
    setConsent({ key: consentKey, ...ack, [flag]: value });
  };
  const recheck = async () => {
    if (active.current) return;
    const next = await read.refresh();
    if (!next) return;
    setConsent(null);
    setFailure(null);
    setCompleted(null);
    const value = comparison
      ? next.cases.some((item) => caseMatchesComparison(item, comparison))
        ? 'A matching saved check is present.'
        : 'No matching saved check is present.'
      : next.cases.some((item) => item.id === record?.id)
        ? 'This saved check is still present.'
        : 'This saved check is no longer present.';
    setMessage({ state: next, value });
  };
  const mutate = async () => {
    if (
      !key ||
      !read.workspaceId ||
      !read.state ||
      active.current ||
      read.loading ||
      error?.unknown ||
      receipt ||
      !ack.shared ||
      (mode === 'save' ? !policyMatches : !selectionMatches || !ack.weaken)
    )
      return;
    const capturedKey = key;
    const workspaceId = read.workspaceId;
    const controller = new AbortController();
    const accepts = () =>
      currentKey.current === capturedKey && active.current?.controller === controller;
    const unknown = () => {
      if (!accepts()) return;
      active.current = null;
      setProgress({ key: capturedKey, busy: false });
      setConsent(null);
      setFailure({
        key: capturedKey,
        unknown: true,
        message:
          'Completion is unknown. Saved checks may have changed. Recheck before another action.',
      });
    };
    const timer = setTimeout(() => {
      controller.abort();
      unknown();
    }, 25_000);
    active.current = { controller, timer };
    setProgress({ key: capturedKey, busy: true });
    setFailure(null);
    setMessage(null);
    const input = comparison
      ? {
          incidentId: comparison.incidentId,
          expectedEvidenceSha: comparison.evidenceSha,
          expectedPolicyFingerprint: comparison.currentPolicy.semanticSha,
          expectedPolicyRawSha: comparison.currentPolicy.rawSha,
          expectedStoreRevision: read.state.revision,
          acknowledgeSharedScope: true,
        }
      : {
          caseId: record!.id,
          expectedStoreRevision: read.state.revision,
          acknowledgeSharedScope: true,
          acknowledgeWeakenChecks: true,
        };
    try {
      const value = await requestLocal(`/api/policy/cases/${mode}`, input, controller.signal);
      if (
        controller.signal.aborted ||
        !validatePolicyCaseReceipt(value) ||
        !(comparison
          ? saveReceiptMatches(value, comparison, workspaceId)
          : removedReceiptMatches(value, record!.id, workspaceId))
      )
        throw new Error();
      if (!accepts()) return;
      active.current = null;
      setConsent(null);
      setCompleted({ key: capturedKey, receipt: value });
      setProgress({ key: capturedKey, busy: false });
      onCompleted?.();
    } catch {
      unknown();
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    ...read,
    busy,
    receipt,
    policyMatches,
    selectionMatches,
    ackSharedScope: ack.shared,
    ackWeakenChecks: ack.weaken,
    acknowledge,
    mutate,
    recheck,
    mutationError: error?.message ?? null,
    needsRecheck: error?.unknown ?? false,
    message: message?.state === read.state ? message.value : null,
  };
}
