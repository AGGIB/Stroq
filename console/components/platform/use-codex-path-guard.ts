'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  validateCodexPathGuardCapture,
  validateCodexPathGuardState,
  validateCodexPathGuardRecord,
  validateCodexPathGuardReceipt,
  type CodexPathGuardCapture,
  type CodexPathGuardState,
  type CodexPathGuardPreview,
  type CodexPathGuardReceipt,
  type CodexPathGuardRecord,
  type CodexPathGuardSelection,
  type CodexPathGuardRestoreSelection,
} from '@/lib/codex-path-guard';
import {
  codexPathGuardPending,
  pathGuardPreviewMatches,
  pathGuardReceiptMatches,
  confirmPathGuard,
  pathGuardPendingKey,
  notifyCodexPathGuardPending,
  subscribeCodexPathGuardPending,
  PATH_GUARD_PENDING_LIMIT,
} from '@/lib/codex-path-guard-client';
import { useCodexPathGuardSession } from './use-codex-path-guard-session';
import type { CodexPathGuardPresetId } from '@/lib/codex-path-guard';
type Ack = { shared: boolean; retention: boolean; weakening: boolean };
const empty = (): Ack => ({ shared: false, retention: false, weakening: false });
export function useCodexPathGuard(open: boolean) {
  const session = useCodexPathGuardSession(open);
  const { key, requestLocal, begin, fail } = session;
  const [saved, setSaved] = useState<{ key: string; value: CodexPathGuardState } | null>(null),
    [captured, setCaptured] = useState<{ key: string; value: CodexPathGuardCapture } | null>(null),
    [planned, setPlanned] = useState<{ key: string; value: CodexPathGuardPreview } | null>(null),
    [completed, setCompleted] = useState<{ key: string; value: CodexPathGuardReceipt } | null>(
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
    () => subscribeCodexPathGuardPending(requestLocal, () => changed((n) => n + 1)),
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
      codexPathGuardPending(requestLocal).size >= PATH_GUARD_PENDING_LIMIT ||
      [...codexPathGuardPending(requestLocal).values()].some(
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
      const value = await requestLocal('/api/codex-path-guard', undefined, run.signal);
      if (!run.accepts()) return false;
      if (!validateCodexPathGuardState(value)) throw Error();
      setSaved({ key, value });
      return true;
    } catch (error) {
      if (run.accepts()) fail('Saved path changes could not be verified.', error);
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
      const value = await requestLocal('/api/codex-path-guard/capture', {}, run.signal);
      if (!run.accepts()) return;
      if (
        !validateCodexPathGuardCapture(value) ||
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
    async (request: CodexPathGuardSelection | CodexPathGuardRestoreSelection) => {
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
        const value = await requestLocal('/api/codex-path-guard/preview', request, run.signal);
        if (!run.accepts()) return;
        if (
          !pathGuardPreviewMatches(
            value,
            request,
            inspected,
            request.operation === 'restore'
              ? latest.current.state?.records.find(
                  (r) => r.id === request.recordId && r.revision === request.recordRevision,
                )
              : undefined,
          )
        )
          throw Error();
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
  const prepare = useCallback(
    async (presetId: CodexPathGuardPresetId) => {
      const c = latest.current.capture;
      if (!c?.binding || !c.presets.some((p) => p.id === presetId && p.canGuard)) return;
      await prepareRequest({
        operation: 'guard',
        controlContextId: c.binding.controlContextId,
        captureSha256: c.binding.captureSha256,
        presetId,
      });
    },
    [prepareRequest],
  );
  const prepareRestore = useCallback(
    async (record: CodexPathGuardRecord) => {
      if (
        !validateCodexPathGuardRecord(record) ||
        !latest.current.state?.records.some(
          (r) =>
            r.id === record.id &&
            r.revision === record.revision &&
            r.operationId === record.operationId &&
            r.canRestore &&
            r.presetId === record.presetId,
        ) ||
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
    (value: CodexPathGuardReceipt) => {
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
    codexPathGuardPending(requestLocal).set(pathGuardPendingKey(p.controlContextId, p.recordId), {
      preview: p,
      startedAt: new Date().toISOString(),
    });
    notifyCodexPathGuardPending(requestLocal);
    clearPreview();
    setCaptured(null);
    try {
      const value = await requestLocal(
        '/api/codex-path-guard/apply',
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
      if (!pathGuardReceiptMatches(value, p)) throw Error();
      acceptReceipt(value);
      confirmPathGuard(requestLocal, value);
      if (!value.writeConfirmed) fail('Completion is unknown. Recheck this exact change.');
    } catch {
      if (run.accepts()) fail('Completion is unknown. Recheck this exact change.');
    } finally {
      run.finish();
    }
  }, [begin, key, requestLocal, clearPreview, fail, acceptReceipt]);
  const recheck = useCallback(
    async (record: CodexPathGuardRecord) => {
      if (
        !validateCodexPathGuardRecord(record) ||
        record.controlContextId !== latest.current.state?.controlContextId
      )
        return;
      const pending = codexPathGuardPending(requestLocal).get(
        pathGuardPendingKey(record.controlContextId, record.id),
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
          '/api/codex-path-guard/recheck',
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
          !validateCodexPathGuardReceipt(value) ||
          value.operation !== 'recheck' ||
          value.controlContextId !== record.controlContextId ||
          value.record.id !== record.id ||
          value.operationId !== record.operationId ||
          value.record.presetId !== record.presetId ||
          value.record.kind !== record.kind ||
          value.record.originalSha256 !== record.originalSha256 ||
          value.record.candidateSha256 !== record.candidateSha256 ||
          value.checkedAt < record.updatedAt ||
          (pending && !pathGuardReceiptMatches(value, pending.preview, true))
        )
          throw Error();
        acceptReceipt(value);
        confirmPathGuard(requestLocal, value);
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
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (key) void refreshRef.current();
  }, [key]);
  const all = [...codexPathGuardPending(requestLocal).values()],
    context = state?.controlContextId;
  return {
    busy: session.busy,
    error: session.error,
    connected: session.key !== null,
    close: () => {
      clearPreview();
      session.cancel();
    },
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
    canPrepare: !session.isBusy() && !blocked(),
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
export type CodexPathGuardAction = ReturnType<typeof useCodexPathGuard>;
