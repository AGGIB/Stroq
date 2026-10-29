'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import {
  validateCodexSkillControlReceipt,
  validateCodexSkillControlRecord,
  validateCodexSkillControlState,
  type CodexSkillControlPreview,
  type CodexSkillControlReceipt,
  type CodexSkillControlRecord,
  type CodexSkillControlSelection,
  type CodexSkillControlRestoreSelection,
  type CodexSkillControlState,
} from '@/lib/codex-skill-controls';
import {
  CODEX_SKILL_CONTROL_PENDING_LIMIT,
  classifyCodexSkillControlPending,
  codexSkillControlPendingWrites,
  codexSkillControlPendingKey,
  codexSkillDisableSelection,
  codexSkillControlPreviewMatches,
  codexSkillControlReceiptMatches,
  confirmCodexSkillControlWrite,
  notifyCodexSkillControlPending,
  subscribeCodexSkillControlPending,
  codexSkillControlMessage,
  codexSkillControlUnfinished,
} from '@/lib/codex-skill-controls-client';
import type { CodexSkillSourcesReport, CodexSkillSourceItem } from '@/lib/codex-skill-sources';
import { useCodexSkillControlOperation } from './use-codex-skill-control-operation';
type Ack = { shared: boolean; retention: boolean; weakening: boolean };
const emptyAck = (): Ack => ({ shared: false, retention: false, weakening: false });
export function useCodexSkillControls(enabled: boolean, onChanged: () => void) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
  const identity = useRef({ enabled, localContext, requestLocal, generation: 0 });
  if (
    identity.current.enabled !== enabled ||
    identity.current.localContext !== localContext ||
    identity.current.requestLocal !== requestLocal
  )
    identity.current = {
      enabled,
      localContext,
      requestLocal,
      generation: identity.current.generation + 1,
    };
  const key = enabled && workspaceId ? `${workspaceId}:${identity.current.generation}` : null;
  const current = useRef(key);
  current.current = key;
  const [snapshot, setSnapshot] = useState<{ key: string; value: CodexSkillControlState } | null>(
    null,
  );
  const [plan, setPlan] = useState<{ key: string; value: CodexSkillControlPreview } | null>(null);
  const [consent, setConsent] = useState<{ id: string; value: Ack } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [result, setResult] = useState<{ key: string; value: CodexSkillControlReceipt } | null>(
    null,
  );
  const [, changed] = useState(0);
  const state = key && snapshot?.key === key ? snapshot.value : null;
  const preview = key && plan?.key === key ? plan.value : null;
  const ack = preview && consent?.id === preview.id ? consent.value : emptyAck();
  const latest = useRef({ state, preview, ack });
  latest.current = { state, preview, ack };
  const clearPreview = useCallback(() => {
    latest.current.preview = null;
    latest.current.ack = emptyAck();
    setPlan(null);
    setConsent(null);
  }, []);
  const operation = useCodexSkillControlOperation(key, (kind) => {
    if (!key) return;
    clearPreview();
    setFailure({
      key,
      message:
        kind === 'apply'
          ? 'Completion is unknown. Recheck this exact change.'
          : 'The local operation timed out. Reload or prepare a fresh preview.',
    });
  });
  const cancel = useCallback(() => {
    operation.cancel();
    clearPreview();
  }, [operation.cancel, clearPreview]);
  const begin = useCallback(
    (kind: Parameters<typeof operation.begin>[0]) => {
      const run = operation.begin(kind);
      if (run) {
        setFailure(null);
        setResult(null);
      }
      return run;
    },
    [operation.begin],
  );
  const refresh = useCallback(async () => {
    const run = begin('load');
    if (!run || !key) return;
    clearPreview();
    setSnapshot(null);
    try {
      const value = await requestLocal(
        '/api/inventory/codex-controls',
        undefined,
        run.pending.controller.signal,
      );
      if (!run.accepts()) return;
      if (!validateCodexSkillControlState(value)) throw Error();
      setSnapshot({ key, value });
    } catch (error) {
      if (run.accepts())
        setFailure({
          key,
          message: codexSkillControlMessage(error, 'Saved skill changes could not be verified.'),
        });
    } finally {
      run.finish();
    }
  }, [begin, key, clearPreview, requestLocal]);
  useEffect(() => {
    if (key) void refresh();
    return () => {
      cancel();
    };
  }, [key, refresh, cancel]);
  useEffect(
    () => subscribeCodexSkillControlPending(requestLocal, () => changed((n) => n + 1)),
    [requestLocal],
  );
  useEffect(() => {
    if (!preview || !key) return;
    const timer = setTimeout(
      () => {
        clearPreview();
        setFailure({ key, message: 'Preview expired. Prepare a fresh preview.' });
      },
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [preview, key, clearPreview]);
  const blocked = () => {
    const value = latest.current.state;
    return (
      !value?.available ||
      !value.controlContextId ||
      value.records.some(codexSkillControlUnfinished) ||
      codexSkillControlPendingWrites(requestLocal).size >= CODEX_SKILL_CONTROL_PENDING_LIMIT ||
      classifyCodexSkillControlPending(requestLocal, value.controlContextId).pending.length > 0
    );
  };
  const prepare = useCallback(
    async (request: CodexSkillControlSelection | CodexSkillControlRestoreSelection) => {
      if (blocked() || request.controlContextId !== latest.current.state?.controlContextId) {
        if (key)
          setFailure({
            key,
            message: 'Recheck unfinished changes and reload the current Codex configuration first.',
          });
        return;
      }
      const run = begin('preview');
      if (!run || !key) return;
      clearPreview();
      try {
        const value = await requestLocal(
          '/api/inventory/codex-control-preview',
          request,
          run.pending.controller.signal,
        );
        if (!run.accepts()) return;
        if (!codexSkillControlPreviewMatches(value, request)) throw Error();
        setPlan({ key, value });
        setConsent({ id: value.id, value: emptyAck() });
      } catch (error) {
        if (run.accepts())
          setFailure({
            key,
            message: codexSkillControlMessage(
              error,
              'The exact change could not be previewed. Inspect or reload again.',
            ),
          });
      } finally {
        run.finish();
      }
    },
    [begin, key, clearPreview, requestLocal],
  );
  const prepareDisable = useCallback(
    async (report: CodexSkillSourcesReport, item: CodexSkillSourceItem, historical = false) => {
      const request = historical ? null : codexSkillDisableSelection(report, item);
      if (!request) {
        if (key)
          setFailure({
            key,
            message: 'Inspect this entrypoint again before changing its declaration.',
          });
        return;
      }
      await prepare(request);
    },
    [key, prepare],
  );
  const prepareRestore = useCallback(
    async (record: CodexSkillControlRecord) => {
      if (!validateCodexSkillControlRecord(record) || !record.canRestore) return;
      await prepare({
        operation: 'restore',
        controlContextId: record.controlContextId,
        recordId: record.id,
        recordRevision: record.revision,
      });
    },
    [prepare],
  );
  const acknowledge = useCallback(
    (field: keyof Ack, value: boolean) => {
      const p = latest.current.preview;
      if (!p || !key || current.current !== key) return;
      const next = { ...latest.current.ack, [field]: value };
      latest.current.ack = next;
      setConsent({ id: p.id, value: next });
    },
    [key],
  );
  const mergeReceipt = useCallback(
    (receipt: CodexSkillControlReceipt) => {
      if (!key) return;
      setSnapshot((previous) =>
        previous?.key === key && previous.value.controlContextId === receipt.controlContextId
          ? {
              key,
              value: {
                ...previous.value,
                records: [
                  ...previous.value.records.filter((r) => r.id !== receipt.record.id),
                  receipt.record,
                ],
              },
            }
          : previous,
      );
      setResult({ key, value: receipt });
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
    const pending = codexSkillControlPendingWrites(requestLocal);
    pending.set(codexSkillControlPendingKey(p), {
      preview: p,
      startedAt: new Date().toISOString(),
    });
    notifyCodexSkillControlPending(requestLocal);
    clearPreview();
    onChanged();
    try {
      const value = await requestLocal(
        '/api/inventory/codex-control-apply',
        {
          controlContextId: p.controlContextId,
          previewId: p.id,
          acknowledgeSharedUserConfig: true,
          acknowledgeRetention: true,
          ...(p.operation === 'restore' ? { acknowledgeWeakening: true } : {}),
        },
        run.pending.controller.signal,
      );
      if (!run.accepts()) return;
      if (!codexSkillControlReceiptMatches(value, p)) throw Error();
      mergeReceipt(value);
      confirmCodexSkillControlWrite(requestLocal, value);
      if (!value.writeConfirmed)
        setFailure({ key, message: 'Completion is unknown. Recheck this exact change.' });
    } catch {
      if (run.accepts())
        setFailure({ key, message: 'Completion is unknown. Recheck this exact change.' });
    } finally {
      run.finish();
    }
  }, [begin, key, requestLocal, clearPreview, onChanged, mergeReceipt]);
  const recheck = useCallback(
    async (record: CodexSkillControlRecord) => {
      if (
        !validateCodexSkillControlRecord(record) ||
        record.controlContextId !== latest.current.state?.controlContextId
      )
        return;
      const write = codexSkillControlPendingWrites(requestLocal).get(
        `${record.controlContextId}:${record.id}`,
      );
      if (write && write.preview.operationId !== record.operationId) {
        if (key)
          setFailure({
            key,
            message:
              'This saved record belongs to a different operation. Earlier completion remains unknown.',
          });
        return;
      }
      const run = begin('recheck');
      if (!run || !key) return;
      clearPreview();
      try {
        const value = await requestLocal(
          '/api/inventory/codex-control-recheck',
          {
            controlContextId: record.controlContextId,
            recordId: record.id,
            recordRevision: record.revision,
            operationId: record.operationId,
          },
          run.pending.controller.signal,
        );
        if (!run.accepts()) return;
        if (
          !validateCodexSkillControlReceipt(value) ||
          value.operation !== 'recheck' ||
          value.controlContextId !== record.controlContextId ||
          value.record.id !== record.id ||
          value.operationId !== record.operationId ||
          (write && !codexSkillControlReceiptMatches(value, write.preview, true))
        )
          throw Error();
        mergeReceipt(value);
        confirmCodexSkillControlWrite(requestLocal, value);
        if (!value.writeConfirmed)
          setFailure({
            key,
            message: 'Completion remains unknown. Configuration was not retried.',
          });
      } catch (error) {
        if (run.accepts())
          setFailure({
            key,
            message: codexSkillControlMessage(
              error,
              'This exact change could not be rechecked. Completion remains unknown.',
            ),
          });
      } finally {
        run.finish();
      }
    },
    [begin, key, requestLocal, clearPreview, mergeReceipt],
  );
  return {
    state,
    connected: key !== null,
    preview,
    ack,
    available: !!state?.available,
    busy: operation.busy,
    error: key && failure?.key === key ? failure.message : null,
    completion: key && result?.key === key ? result.value : null,
    canApply:
      !!preview &&
      !operation.isBusy() &&
      ack.shared &&
      ack.retention &&
      (preview.operation !== 'restore' || ack.weakening) &&
      Date.parse(preview.expiresAt) > Date.now() &&
      !blocked(),
    ...classifyCodexSkillControlPending(requestLocal, state?.controlContextId ?? null),
    refresh,
    prepareDisable,
    prepareRestore,
    acknowledge,
    apply,
    recheck,
    cancel,
    clearPreview,
  };
}
export type CodexSkillControlAction = ReturnType<typeof useCodexSkillControls>;
