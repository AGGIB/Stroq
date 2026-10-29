'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import {
  WORKSPACE_TASK_ERROR_MESSAGES,
  validateWorkspaceTaskReceipt,
  validateWorkspaceTaskState,
  type WorkspaceTaskPreview,
  type WorkspaceTaskReceipt,
  type WorkspaceTaskRecord,
  type WorkspaceTaskState,
} from '@/lib/workspace-task-controls';
import {
  sameWorkspaceTaskRecord,
  workspaceTaskBindingFor,
  workspaceTaskPreviewMatches,
  workspaceTaskReceiptMatches,
  workspaceTaskRecordMatchesPreview,
} from '@/lib/workspace-task-controls-binding';
import {
  workspaceTaskConfirmRecheck,
  workspaceTaskPendingWrites,
} from '@/lib/workspace-task-controls-recheck';
import type { WorkspaceReviewRun, WorkspaceReviewSource } from '@/lib/workspace-review';

type Operation = 'load' | 'preview' | 'apply' | 'recheck';
type Ack = { effects: boolean; retention: boolean };
const emptyAck = (): Ack => ({ effects: false, retention: false });
const unfinished = (record: WorkspaceTaskRecord) =>
  ['prepared', 'restoring', 'uncertain'].includes(record.status);
export function useWorkspaceTaskControls({
  workspaceId,
  enabled,
  run,
  selectionKey = '',
}: {
  workspaceId: string | null;
  enabled: boolean;
  run: WorkspaceReviewRun | null;
  selectionKey?: string;
}) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const scope =
    enabled && localAccess && workspaceId === localContext?.workspace.id ? workspaceId : null;
  const selected = `${scope}:${run?.id}:${run?.result?.capture.captureSha256}:${selectionKey}`;
  const identity = useRef({ selected, localContext, requestLocal, generation: 0 });
  if (
    identity.current.selected !== selected ||
    identity.current.localContext !== localContext ||
    identity.current.requestLocal !== requestLocal
  )
    identity.current = {
      selected,
      localContext,
      requestLocal,
      generation: identity.current.generation + 1,
    };
  const key = scope ? `${selected}:${identity.current.generation}` : null;
  const mounted = useRef(false),
    current = useRef(key);
  current.current = key;
  const active = useRef<{
    key: string;
    operation: Operation;
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [snapshot, setSnapshot] = useState<{ key: string; value: WorkspaceTaskState } | null>(null);
  const [plan, setPlan] = useState<{ key: string; value: WorkspaceTaskPreview } | null>(null);
  const [consent, setConsent] = useState<{ id: string; value: Ack } | null>(null);
  const [progress, setProgress] = useState<{ key: string; operation: Operation } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [dialog, setDialog] = useState<{
    key: string;
    operation: WorkspaceTaskPreview['operation'];
  } | null>(null);
  const [completion, setCompletion] = useState<{
    key: string;
    receipt: WorkspaceTaskReceipt;
  } | null>(null);
  const [, changed] = useState(0);
  const state = key && snapshot?.key === key ? snapshot.value : null;
  const preview = key && plan?.key === key ? plan.value : null;
  const ack = preview && consent?.id === preview.id ? consent.value : emptyAck();
  const busy = key && progress?.key === key ? progress.operation : null;
  const pending = workspaceTaskPendingWrites(requestLocal);
  const unresolved = [...pending.values()].filter((write) => write.preview.workspaceId === scope);
  const unresolvedRecords = state?.records.filter(unfinished) ?? [];
  const needsRecheck = unresolved.length > 0 || unresolvedRecords.length > 0;
  const latest = useRef({ state, preview, ack, run });
  latest.current = { state, preview, ack, run };
  const clearPlan = useCallback(() => {
    latest.current.preview = null;
    latest.current.ack = emptyAck();
    setPlan(null);
    setConsent(null);
  }, []);
  const begin = useCallback(
    (operation: Operation) => {
      if (!mounted.current || !key || current.current !== key || active.current) return null;
      const controller = new AbortController();
      const record = {
        key,
        operation,
        controller,
        timer: undefined! as ReturnType<typeof setTimeout>,
      };
      const accepts = () => mounted.current && current.current === key && active.current === record;
      record.timer = setTimeout(
        () => {
          if (!accepts()) return;
          controller.abort();
          active.current = null;
          setProgress(null);
          clearPlan();
          setFailure({
            key,
            message:
              operation === 'apply'
                ? 'Completion is unknown. Recheck this change before another action.'
                : 'The local operation timed out. Retry the read or prepare a fresh preview.',
          });
        },
        operation === 'apply' ? 60_000 : 30_000,
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
    [key, clearPlan],
  );
  const load = useCallback(async () => {
    const request = begin('load');
    if (!request || !key || !scope) return;
    try {
      const value = await requestLocal(
        '/api/workspace-task-controls',
        undefined,
        request.record.controller.signal,
      );
      if (!request.valid()) return;
      if (!validateWorkspaceTaskState(value) || value.workspaceId !== scope) throw Error();
      setSnapshot({ key, value });
    } catch {
      if (request.accepts())
        setFailure({
          key,
          message: 'Task change history could not be verified. Earlier records remain historical.',
        });
    } finally {
      request.finish();
    }
  }, [begin, key, scope, requestLocal]);
  useEffect(() => {
    mounted.current = true;
    clearPlan();
    setDialog(null);
    setFailure(null);
    setProgress(null);
    setCompletion(null);
    return () => {
      mounted.current = false;
      if (active.current) {
        active.current.controller.abort();
        clearTimeout(active.current.timer);
      }
      active.current = null;
    };
  }, [key, clearPlan]);
  useEffect(() => {
    if (key) void load();
  }, [key, load]);
  useEffect(() => {
    if (!key || !preview) return;
    const timer = setTimeout(
      () => {
        if (current.current !== key || latest.current.preview !== preview) return;
        clearPlan();
        setFailure({ key, message: 'Preview expired. Prepare the change again.' });
      },
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [key, preview, clearPlan]);
  const prepare = async (source?: WorkspaceReviewSource, restore?: WorkspaceTaskRecord) => {
    if (
      !key ||
      !scope ||
      !latest.current.state?.available ||
      latest.current.state.records.some(unfinished) ||
      [...pending.values()].some((write) => write.preview.workspaceId === scope) ||
      (!restore && latest.current.run?.workspaceId !== scope)
    )
      return;
    const binding =
      restore?.binding ?? (source ? workspaceTaskBindingFor(latest.current.run, source) : null);
    if (
      !binding ||
      (restore &&
        (!restore.canRestore ||
          restore.workspaceId !== scope ||
          !latest.current.state.records.some(
            (record) =>
              record.id === restore.id &&
              record.revision === restore.revision &&
              record.canRestore &&
              sameWorkspaceTaskRecord(record, restore),
          )))
    )
      return;
    const request = begin('preview');
    if (!request) return;
    clearPlan();
    setDialog({ key, operation: restore ? 'restore' : 'make-manual' });
    try {
      const value = await requestLocal(
        `/api/workspace-task-controls/${restore ? 'restore-preview' : 'preview'}`,
        restore
          ? { recordId: restore.id, expectedRevision: restore.revision }
          : {
              runId: binding.runId,
              expectedCaptureSha256: binding.captureSha256,
              sourceId: binding.sourceId,
              expectedSourceSha256: binding.sourceSha256,
            },
        request.record.controller.signal,
      );
      if (!request.valid()) return;
      if (
        !workspaceTaskPreviewMatches(value, binding, scope, restore) ||
        Date.parse(value.expiresAt) <= Date.now() ||
        Date.parse(value.createdAt) > Date.now()
      )
        throw Error();
      setPlan({ key, value });
    } catch (error) {
      if (request.accepts())
        setFailure({
          key,
          message:
            error instanceof Error &&
            Object.values(WORKSPACE_TASK_ERROR_MESSAGES).includes(error.message)
              ? error.message
              : 'This exact task change could not be previewed. Recheck the source and recovery history.',
        });
    } finally {
      request.finish();
    }
  };
  const acknowledge = (name: keyof Ack, value: boolean) => {
    if (
      !mounted.current ||
      !key ||
      current.current !== key ||
      active.current ||
      !preview ||
      latest.current.preview !== preview ||
      Date.parse(preview.expiresAt) <= Date.now()
    )
      return;
    latest.current.ack = { ...latest.current.ack, [name]: value };
    setConsent({ id: preview.id, value: latest.current.ack });
  };
  const acceptReceipt = (value: WorkspaceTaskReceipt) => {
    if (!key) return;
    setCompletion({ key, receipt: value });
    setSnapshot((previous) =>
      previous?.key === key
        ? {
            key,
            value: {
              ...previous.value,
              generatedAt: value.checkedAt,
              history: previous.value.available ? 'ready' : previous.value.history,
              records: [
                value.record,
                ...previous.value.records.filter((record) => record.id !== value.record.id),
              ].slice(0, 32),
            },
          }
        : previous,
    );
  };
  const apply = async () => {
    if (
      !key ||
      !scope ||
      !preview ||
      latest.current.preview !== preview ||
      !latest.current.ack.effects ||
      !latest.current.ack.retention ||
      !latest.current.state?.available ||
      latest.current.state.records.some(unfinished) ||
      [...pending.values()].some((write) => write.preview.workspaceId === scope) ||
      Date.parse(preview.expiresAt) <= Date.now() ||
      pending.size >= 64
    )
      return;
    const request = begin('apply');
    if (!request) return;
    const startedAt = new Date().toISOString();
    pending.set(preview.recordId, { preview, startedAt });
    changed((n) => n + 1);
    clearPlan();
    try {
      const value = await requestLocal(
        `/api/workspace-task-controls/${preview.operation === 'restore' ? 'restore' : 'apply'}`,
        {
          previewId: preview.id,
          ...(preview.operation === 'restore'
            ? { acknowledgeAutomaticExecution: true }
            : { acknowledgeWorkspaceChange: true }),
          acknowledgeRecoveryRetention: true,
        },
        request.record.controller.signal,
      );
      if (!request.valid()) return;
      if (!workspaceTaskReceiptMatches(value, preview, startedAt)) throw Error();
      pending.delete(preview.recordId);
      changed((n) => n + 1);
      acceptReceipt(value);
      setDialog(null);
    } catch {
      if (request.accepts()) {
        setFailure({
          key,
          message: 'Completion is unknown. Recheck this change before another action.',
        });
        setDialog(null);
      }
    } finally {
      request.finish();
    }
  };
  const recheck = async (recordId: string) => {
    if (!key || !scope) return;
    const write = pending.get(recordId),
      record = latest.current.state?.records.find((record) => record.id === recordId);
    if (
      (!write || write.preview.workspaceId !== scope) &&
      (!record || record.workspaceId !== scope)
    )
      return;
    const request = begin('recheck');
    if (!request) return;
    const startedAt = new Date().toISOString();
    try {
      const value = await requestLocal(
        '/api/workspace-task-controls/recheck',
        { recordId },
        request.record.controller.signal,
      );
      if (!request.valid()) return;
      if (
        !validateWorkspaceTaskReceipt(value) ||
        value.operation !== 'recheck' ||
        value.workspaceId !== scope ||
        value.record.id !== recordId ||
        value.checkedAt < startedAt ||
        (write
          ? !workspaceTaskRecordMatchesPreview(value.record, write.preview)
          : !sameWorkspaceTaskRecord(value.record, record!))
      )
        throw Error();
      workspaceTaskConfirmRecheck(requestLocal, value);
      changed((n) => n + 1);
      acceptReceipt(value);
    } catch {
      if (request.accepts())
        setFailure({
          key,
          message: 'This exact change could not be rechecked. Its completion remains unverified.',
        });
    } finally {
      request.finish();
    }
  };
  return {
    state,
    preview,
    ack,
    busy,
    needsRecheck,
    unresolved,
    unresolvedRecords,
    receipt: key && completion?.key === key ? completion.receipt : null,
    error: key && failure?.key === key ? failure.message : null,
    open: key !== null && dialog?.key === key,
    operation: dialog?.key === key ? dialog.operation : 'make-manual',
    canPrepare: !!state?.available && !busy && !needsRecheck,
    refresh: load,
    prepare: (source: WorkspaceReviewSource) => prepare(source),
    prepareRestore: (record: WorkspaceTaskRecord) => prepare(undefined, record),
    acknowledge,
    apply,
    recheck,
    close: () => {
      if (!mounted.current || current.current !== key || active.current?.operation === 'apply')
        return;
      clearPlan();
      setDialog(null);
    },
  };
}
