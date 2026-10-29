'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  validateCodexNetworkGuardCapture,
  validateCodexNetworkGuardState,
  validateCodexNetworkGuardRecord,
  validateCodexNetworkGuardReceipt,
  type CodexNetworkGuardCapture,
  type CodexNetworkGuardState,
  type CodexNetworkGuardPreview,
  type CodexNetworkGuardReceipt,
  type CodexNetworkGuardRecord,
  type CodexNetworkGuardSelection,
  type CodexNetworkGuardRestoreSelection,
} from '@/lib/codex-network-guard';
import {
  codexNetworkGuardPending,
  guardPreviewMatches,
  guardReceiptMatches,
  confirmNetworkGuard,
  networkPendingKey,
  notifyCodexNetworkPending,
  subscribeCodexNetworkPending,
  NETWORK_PENDING_LIMIT,
} from '@/lib/codex-network-client';
import type { CodexNetworkSession } from './use-codex-network-session';
type Ack = { shared: boolean; retention: boolean; weakening: boolean };
const empty = (): Ack => ({ shared: false, retention: false, weakening: false });
export function useCodexNetworkGuard(session: CodexNetworkSession) {
  const { key, requestLocal, begin, fail } = session;
  const [saved, setSaved] = useState<{ key: string; value: CodexNetworkGuardState } | null>(null),
    [captured, setCaptured] = useState<{ key: string; value: CodexNetworkGuardCapture } | null>(
      null,
    ),
    [planned, setPlanned] = useState<{ key: string; value: CodexNetworkGuardPreview } | null>(null),
    [completed, setCompleted] = useState<{ key: string; value: CodexNetworkGuardReceipt } | null>(
      null,
    ),
    [consent, setConsent] = useState<{ id: string; value: Ack } | null>(null);
  const [, changed] = useState(0);
  const state = key && saved?.key === key ? saved.value : null,
    capture = key && captured?.key === key ? captured.value : null,
    preview = key && planned?.key === key ? planned.value : null,
    receipt = key && completed?.key === key ? completed.value : null,
    ack = preview && consent?.id === preview.id ? consent.value : empty();
  const latest = useRef({ state, capture, preview, ack });
  latest.current = { state, capture, preview, ack };
  const clearPreview = useCallback(() => {
    latest.current.preview = null;
    latest.current.ack = empty();
    setPlanned(null);
    setConsent(null);
  }, []);
  const read = useCallback(() => latest.current, []);
  useEffect(
    () => subscribeCodexNetworkPending(requestLocal, () => changed((n) => n + 1)),
    [requestLocal],
  );
  useEffect(() => {
    clearPreview();
  }, [key, clearPreview]);
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(
      () => {
        clearPreview();
        fail('Preview expired. Prepare a new review.');
      },
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [preview, key, clearPreview, fail]);
  const blocked = () => {
    const s = latest.current.state;
    return (
      !s?.available ||
      !s.controlContextId ||
      s.records.some((r) => r.operationStatus === 'unknown') ||
      codexNetworkGuardPending(requestLocal).size >= NETWORK_PENDING_LIMIT ||
      [...codexNetworkGuardPending(requestLocal).values()].some(
        (w) => w.preview.controlContextId === s.controlContextId,
      )
    );
  };
  const refresh = useCallback(async () => {
    const run = begin('load');
    if (!run || !key) return false;
    clearPreview();
    setSaved(null);
    try {
      const value = await requestLocal('/api/codex-network-guard', undefined, run.signal);
      if (!run.accepts()) return false;
      if (!validateCodexNetworkGuardState(value)) throw Error();
      setSaved({ key, value });
      return true;
    } catch (error) {
      if (run.accepts()) fail('Saved network changes could not be verified.', error);
      return false;
    } finally {
      run.finish();
    }
  }, [begin, key, requestLocal, clearPreview, fail]);
  const inspect = useCallback(async () => {
    const run = begin('capture');
    if (!run || !key) return;
    clearPreview();
    setCaptured(null);
    setCompleted(null);
    try {
      const value = await requestLocal('/api/codex-network-guard/capture', {}, run.signal);
      if (!run.accepts()) return;
      if (
        !validateCodexNetworkGuardCapture(value) ||
        (value.binding &&
          latest.current.state?.controlContextId &&
          value.binding.controlContextId !== latest.current.state.controlContextId)
      )
        throw Error();
      setCaptured({ key, value });
    } catch (error) {
      if (run.accepts()) fail('The current user default could not be inspected.', error);
    } finally {
      run.finish();
    }
  }, [begin, key, requestLocal, clearPreview, fail]);
  const prepareRequest = useCallback(
    async (request: CodexNetworkGuardSelection | CodexNetworkGuardRestoreSelection) => {
      if (blocked() || request.controlContextId !== latest.current.state?.controlContextId) {
        fail('Recheck unfinished changes before preparing another action.');
        return;
      }
      const run = begin('preview');
      if (!run || !key) return;
      clearPreview();
      setCompleted(null);
      const inspected = latest.current.capture;
      try {
        const value = await requestLocal('/api/codex-network-guard/preview', request, run.signal);
        if (!run.accepts()) return;
        if (!guardPreviewMatches(value, request, inspected)) throw Error();
        setPlanned({ key, value });
        setConsent({ id: value.id, value: empty() });
      } catch (error) {
        if (run.accepts()) fail('This exact configuration change could not be previewed.', error);
      } finally {
        run.finish();
      }
    },
    [begin, key, requestLocal, clearPreview, fail],
  );
  const prepare = useCallback(async () => {
    const c = latest.current.capture;
    if (!c?.canGuard || !c.binding) return;
    await prepareRequest({
      operation: 'guard',
      controlContextId: c.binding.controlContextId,
      captureSha256: c.binding.captureSha256,
    });
  }, [prepareRequest]);
  const prepareRestore = useCallback(
    async (record: CodexNetworkGuardRecord) => {
      if (
        !validateCodexNetworkGuardRecord(record) ||
        !record.canRestore ||
        record.ownership !== 'current'
      )
        return;
      await prepareRequest({
        operation: 'restore',
        controlContextId: record.controlContextId,
        recordId: record.id,
        recordRevision: record.revision,
      });
    },
    [prepareRequest],
  );
  const acknowledge = useCallback(
    (field: keyof Ack, value: boolean) => {
      const p = latest.current.preview;
      if (!p || !session.isCurrent()) return;
      const next = { ...latest.current.ack, [field]: value };
      latest.current.ack = next;
      setConsent({ id: p.id, value: next });
    },
    [key],
  );
  const acceptReceipt = useCallback(
    (value: CodexNetworkGuardReceipt) => {
      if (!key) return;
      setCompleted({ key, value });
      setSaved((previous) =>
        previous?.key === key && previous.value.controlContextId === value.controlContextId
          ? {
              key,
              value: {
                ...previous.value,
                records: [
                  value.record,
                  ...previous.value.records.filter((r) => r.id !== value.record.id),
                ],
              },
            }
          : previous,
      );
    },
    [key],
  );
  const apply = useCallback(async () => {
    const { preview: p, ack: a } = latest.current;
    if (
      !p ||
      !a.shared ||
      !a.retention ||
      (p.operation === 'restore' && !a.weakening) ||
      Date.parse(p.expiresAt) <= Date.now() ||
      blocked()
    )
      return;
    const run = begin('apply');
    if (!run || !key) return;
    codexNetworkGuardPending(requestLocal).set(networkPendingKey(p.controlContextId, p.recordId), {
      preview: p,
      startedAt: new Date().toISOString(),
    });
    notifyCodexNetworkPending(requestLocal);
    clearPreview();
    setCaptured(null);
    try {
      const value = await requestLocal(
        '/api/codex-network-guard/apply',
        {
          previewId: p.id,
          controlContextId: p.controlContextId,
          acknowledgeSharedUserConfig: true,
          acknowledgeRetention: true,
          ...(p.operation === 'restore' ? { acknowledgeWeakening: true } : {}),
        },
        run.signal,
      );
      if (!run.accepts()) return;
      if (!guardReceiptMatches(value, p)) throw Error();
      acceptReceipt(value);
      confirmNetworkGuard(requestLocal, value);
      if (!value.writeConfirmed) fail('Completion is unknown. Recheck this exact change.');
    } catch {
      if (run.accepts()) fail('Completion is unknown. Recheck this exact change.');
    } finally {
      run.finish();
    }
  }, [begin, key, requestLocal, clearPreview, fail, acceptReceipt]);
  const recheck = useCallback(
    async (record: CodexNetworkGuardRecord) => {
      if (
        !validateCodexNetworkGuardRecord(record) ||
        record.controlContextId !== latest.current.state?.controlContextId
      )
        return;
      const pending = codexNetworkGuardPending(requestLocal).get(
        networkPendingKey(record.controlContextId, record.id),
      );
      if (pending && pending.preview.operationId !== record.operationId) {
        fail(
          'The retained record belongs to a later operation. Earlier completion remains unknown.',
        );
        return;
      }
      const run = begin('recheck');
      if (!run || !key) return;
      clearPreview();
      try {
        const value = await requestLocal(
          '/api/codex-network-guard/recheck',
          {
            controlContextId: record.controlContextId,
            recordId: record.id,
            recordRevision: record.revision,
            operationId: record.operationId,
          },
          run.signal,
        );
        if (!run.accepts()) return;
        if (
          !validateCodexNetworkGuardReceipt(value) ||
          value.operation !== 'recheck' ||
          value.controlContextId !== record.controlContextId ||
          value.record.id !== record.id ||
          value.operationId !== record.operationId ||
          (pending && !guardReceiptMatches(value, pending.preview, true))
        )
          throw Error();
        acceptReceipt(value);
        confirmNetworkGuard(requestLocal, value);
        if (!value.writeConfirmed)
          fail('Completion remains unknown. The configuration was not retried.');
      } catch (error) {
        if (run.accepts()) fail('The exact change could not be rechecked.', error);
      } finally {
        run.finish();
      }
    },
    [begin, key, requestLocal, clearPreview, fail, acceptReceipt],
  );
  const all = [...codexNetworkGuardPending(requestLocal).values()],
    context = state?.controlContextId;
  return {
    state,
    capture,
    preview,
    receipt,
    ack,
    read,
    refresh,
    inspect,
    prepare,
    prepareRestore,
    acknowledge,
    apply,
    recheck,
    clearPreview,
    pending: context ? all.filter((w) => w.preview.controlContextId === context) : all,
    foreignPending: context ? all.filter((w) => w.preview.controlContextId !== context) : [],
    canApply:
      !!preview &&
      !session.isBusy() &&
      ack.shared &&
      ack.retention &&
      (preview.operation !== 'restore' || ack.weakening) &&
      Date.parse(preview.expiresAt) > Date.now() &&
      !blocked(),
  };
}
export type CodexNetworkGuardAction = ReturnType<typeof useCodexNetworkGuard>;
