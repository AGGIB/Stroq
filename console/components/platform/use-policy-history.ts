'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import {
  validatePolicyHistoryState,
  validatePolicyRestorePreview,
  validatePolicyRestoreReceipt,
  type PolicyHistoryState,
  type PolicyRestorePreview,
  type PolicyRestoreReceipt,
} from '@/lib/policy-history';
import {
  policyRestorePreviewMatches,
  policyRestoreReceiptMatches,
  policyRestoreApplyInput,
  type PolicyRestoreAcknowledgements,
} from '@/lib/policy-restore-binding';
import {
  policyHistoryReadAllowed,
  type PolicyHistorySelection,
} from '@/lib/policy-history-navigation';
import { POLICY_HISTORY_ERROR_MESSAGES } from '@/lib/policy-history-errors';
type Operation = 'load' | 'preview' | 'apply';
const emptyAck = (): PolicyRestoreAcknowledgements => ({
  sharedScope: false,
  reducedProtection: false,
  backup: false,
  interruptions: false,
});
function safeError(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  return (
    Object.entries(POLICY_HISTORY_ERROR_MESSAGES).find(
      ([code, message]) => error.message === code || error.message === message,
    )?.[1] ?? fallback
  );
}
interface Pending {
  key: string;
  operation: Operation;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

export function usePolicyHistory(selection: PolicyHistorySelection) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
  const allowed = policyHistoryReadAllowed(selection, workspaceId);
  const selectedKey = allowed ? JSON.stringify([workspaceId, selection.entryId]) : null;
  const identity = useRef({ selectedKey, requestLocal, context: localContext, generation: 0 });
  if (
    identity.current.selectedKey !== selectedKey ||
    identity.current.requestLocal !== requestLocal ||
    identity.current.context !== localContext
  )
    identity.current = {
      selectedKey,
      requestLocal,
      context: localContext,
      generation: identity.current.generation + 1,
    };
  const key = selectedKey ? `${selectedKey}:${identity.current.generation}` : null;
  const current = useRef(key),
    mounted = useRef(false),
    active = useRef<Pending | null>(null),
    uncertain = useRef(false);
  current.current = key;
  const [unknown, setUnknown] = useState(false);
  const [capture, setCapture] = useState<{ key: string; state: PolicyHistoryState } | null>(null);
  const [plan, setPlan] = useState<{
    key: string;
    state: PolicyHistoryState;
    preview: PolicyRestorePreview;
  } | null>(null);
  const [consent, setConsent] = useState<{
    id: string;
    value: PolicyRestoreAcknowledgements;
  } | null>(null);
  const [completed, setCompleted] = useState<{
    key: string;
    receipt: PolicyRestoreReceipt;
    preview: PolicyRestorePreview;
  } | null>(null);
  const [progress, setProgress] = useState<{ key: string; operation: Operation } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const state = key && capture?.key === key ? capture.state : null;
  const entry =
    state && selection.entryId
      ? (state.entries.find((item) => item.id === selection.entryId) ?? null)
      : null;
  const preview = key && plan?.key === key && plan.state === state ? plan.preview : null;
  const ack = preview && consent?.id === preview.previewId ? consent.value : emptyAck();
  const receipt = key && completed?.key === key ? completed.receipt : null;
  const receiptPreview = receipt ? completed!.preview : null;
  const busy = key && progress?.key === key ? progress.operation : null;
  const needsRecheck = unknown && busy !== 'apply';
  const latest = useRef({ state, entry, preview, ack, receipt });
  latest.current = { state, entry, preview, ack, receipt };
  const clearPlan = useCallback(() => {
    latest.current.preview = null;
    latest.current.ack = emptyAck();
    setPlan(null);
    setConsent(null);
  }, []);
  const markUnknown = useCallback((value: boolean) => {
    uncertain.current = value;
    setUnknown(value);
  }, []);
  const begin = useCallback(
    (operation: Operation) => {
      if (!mounted.current || !key || current.current !== key || active.current) return null;
      const controller = new AbortController(),
        record: Pending = { key, operation, controller, timer: undefined! };
      const accepts = () => mounted.current && current.current === key && active.current === record;
      record.timer = setTimeout(
        () => {
          if (!accepts()) return;
          controller.abort();
          active.current = null;
          setProgress(null);
          clearPlan();
          if (operation === 'apply') markUnknown(true);
          if (operation === 'load') setCapture(null);
          setFailure({
            key,
            message:
              operation === 'apply'
                ? 'Restoration completion is unknown. Recheck the current policy before another change.'
                : operation === 'preview'
                  ? 'The restore test timed out. No restoration was requested.'
                  : 'Recorded changes timed out. Refresh to retry.',
          });
        },
        operation === 'preview' ? 90_000 : operation === 'apply' ? 45_000 : 25_000,
      );
      active.current = record;
      setProgress({ key, operation });
      setFailure(null);
      return {
        record,
        accepts,
        valid: () => accepts() && !controller.signal.aborted,
        finish: () => {
          clearTimeout(record.timer);
          if (active.current === record) {
            active.current = null;
            setProgress(null);
          }
        },
      };
    },
    [key, clearPlan, markUnknown],
  );
  const load = useCallback(
    async (explicitRecheck = false) => {
      const request = begin('load');
      if (!request || !key) return;
      clearPlan();
      try {
        const value = await requestLocal(
          '/api/policy/history',
          undefined,
          request.record.controller.signal,
        );
        if (!request.valid()) return;
        if (!validatePolicyHistoryState(value)) throw new Error();
        setCapture({ key, state: value });
        if (
          explicitRecheck &&
          value.currentValid &&
          value.currentPolicyFingerprint !== null &&
          value.history.status !== 'unavailable'
        )
          markUnknown(false);
      } catch (error) {
        if (request.accepts()) {
          setCapture(null);
          setFailure({
            key,
            message: safeError(
              error,
              'Recorded policy changes are unavailable. No current-policy or empty-history result was inferred.',
            ),
          });
        }
      } finally {
        request.finish();
      }
    },
    [begin, key, requestLocal, clearPlan, markUnknown],
  );
  useEffect(() => {
    mounted.current = true;
    setCapture(null);
    clearPlan();
    setCompleted(null);
    setFailure(null);
    return () => {
      mounted.current = false;
      const pending = active.current;
      if (pending) {
        pending.controller.abort();
        clearTimeout(pending.timer);
      }
      active.current = null;
    };
  }, [key, clearPlan]);
  useEffect(() => {
    if (key) void load();
  }, [key, load]);
  useEffect(() => {
    if (!preview || !key) return;
    const expires = () => {
      if (
        current.current !== key ||
        latest.current.preview !== preview ||
        active.current?.operation === 'apply'
      )
        return;
      clearPlan();
      setFailure({ key, message: 'This restore preview expired. Prepare a fresh preview.' });
    };
    const delay = Date.parse(preview.expiresAt) - Date.now();
    if (delay <= 0) {
      expires();
      return;
    }
    const timer = setTimeout(expires, delay);
    return () => clearTimeout(timer);
  }, [key, preview, clearPlan]);
  const prepare = async () => {
    if (
      !state ||
      !entry ||
      latest.current.state !== state ||
      latest.current.entry !== entry ||
      !state.restoreAvailable ||
      !state.currentValid ||
      entry.recovery === 'unavailable' ||
      uncertain.current
    )
      return;
    const request = begin('preview');
    if (!request || !key) return;
    clearPlan();
    setCompleted(null);
    try {
      const value = await requestLocal(
        '/api/policy/restore/preview',
        {
          entryId: entry.id,
          recordSha256: entry.recordSha256,
          expectedRawSha: state.currentRawSha,
        },
        request.record.controller.signal,
      );
      if (!request.valid()) return;
      if (!validatePolicyRestorePreview(value) || !policyRestorePreviewMatches(value, state, entry))
        throw new Error();
      setPlan({ key, state, preview: value });
    } catch (error) {
      if (request.accepts())
        setFailure({
          key,
          message: safeError(
            error,
            'No verifiable restore preview was returned. Refresh recorded changes before trying again.',
          ),
        });
    } finally {
      request.finish();
    }
  };
  const acknowledge = (name: keyof PolicyRestoreAcknowledgements, value: boolean) => {
    if (
      !mounted.current ||
      !key ||
      current.current !== key ||
      !preview ||
      latest.current.preview !== preview ||
      active.current
    )
      return;
    const next = { ...latest.current.ack, [name]: value };
    latest.current.ack = next;
    setConsent({ id: preview.previewId, value: next });
  };
  const apply = async () => {
    if (
      !state ||
      !entry ||
      !preview ||
      latest.current.state !== state ||
      latest.current.entry !== entry ||
      latest.current.preview !== preview ||
      uncertain.current ||
      !policyRestorePreviewMatches(preview, state, entry)
    )
      return;
    const input = policyRestoreApplyInput(preview, latest.current.ack);
    if (!input) return;
    const request = begin('apply');
    if (!request || !key) return;
    markUnknown(true);
    clearPlan();
    setCompleted(null);
    try {
      const value = await requestLocal(
        '/api/policy/restore/apply',
        input,
        request.record.controller.signal,
      );
      if (!request.valid()) return;
      if (!validatePolicyRestoreReceipt(value) || !policyRestoreReceiptMatches(value, preview))
        throw new Error();
      setCompleted({ key, receipt: value, preview });
      markUnknown(false);
      request.finish();
      await load();
    } catch (error) {
      if (request.accepts())
        setFailure({
          key,
          message: safeError(
            error,
            'The restore acknowledgement could not be verified. Recheck the current policy before another change.',
          ),
        });
    } finally {
      request.finish();
    }
  };
  const getReport = () =>
    mounted.current && key !== null && current.current === key && latest.current.state === state
      ? {
          schema: 'stroq-policy-recovery-export/1',
          scope: 'stroq-home',
          entry,
          preview: latest.current.preview,
          receipt: latest.current.receipt,
          appliedPreview: receiptPreview,
          hostEnforcement: false,
        }
      : null;
  const currentChanged =
    receipt !== null &&
    state !== null &&
    (receipt.rawSha !== state.currentRawSha ||
      receipt.policyFingerprint !== state.currentPolicyFingerprint);
  return {
    allowed,
    localAccess,
    workspaceId,
    state,
    entry,
    preview,
    receipt,
    receiptPreview,
    busy,
    ack,
    needsRecheck,
    currentChanged,
    error: key && failure?.key === key ? failure.message : null,
    canPrepare:
      !!state?.restoreAvailable &&
      !!state?.currentValid &&
      !!entry &&
      entry.recovery !== 'unavailable' &&
      !receipt &&
      !needsRecheck,
    canApply: preview !== null && policyRestoreApplyInput(preview, ack) !== null && !needsRecheck,
    refresh: () => load(true),
    prepare,
    acknowledge,
    apply,
    getReport,
  };
}
