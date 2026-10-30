'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import {
  validateTaskLockPreview,
  validateTaskLockReceipt,
  type TaskLockPreview,
  type TaskLockReceipt,
  type TaskLockRow,
} from '@/lib/task-locks';
import {
  taskLockApplyInput,
  taskLockPreviewMatches,
  taskLockReceiptMatches,
} from '@/lib/task-lock-binding';
import { taskLockReadAllowed, type TaskLockSelection } from '@/lib/task-lock-navigation';
import {
  validateTaskLockPage,
  TASK_LOCK_PAGE_ERROR_MESSAGES,
  type TaskLockPage,
  type TaskLockPageRequest,
} from '@/lib/task-lock-page';
type PageInput = TaskLockPageRequest | undefined;
type Operation = 'load' | 'preview' | 'apply';
function taskPageError(error: unknown) {
  if (error instanceof Error) {
    const fixed = Object.entries(TASK_LOCK_PAGE_ERROR_MESSAGES).find(
      ([code, message]) => error.message === code || error.message === message,
    );
    if (fixed) return fixed[1];
  }
  return 'Task permissions could not be verified. No empty or active state is inferred.';
}
interface Pending {
  key: string;
  workspaceId: string;
  operation: Operation;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

export function useTaskLocks(selection: TaskLockSelection) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
  const allowed = taskLockReadAllowed(selection, workspaceId);
  const selectionKey = allowed
    ? JSON.stringify([
        workspaceId,
        selection.taskId,
        selection.expectedPermitSha256 ?? null,
        selection.originIncidentId ?? null,
      ])
    : null;
  const connection = useRef({ requestLocal, context: localContext, selectionKey, generation: 0 });
  if (
    connection.current.requestLocal !== requestLocal ||
    connection.current.context !== localContext ||
    connection.current.selectionKey !== selectionKey
  ) {
    connection.current.requestLocal = requestLocal;
    connection.current.context = localContext;
    connection.current.selectionKey = selectionKey;
    connection.current.generation += 1;
  }
  const catalog = useRef({
    requestLocal,
    context: localContext,
    workspaceId,
    selectionKey,
    input: undefined as PageInput,
    override: null as string | null,
    trail: [] as PageInput[],
  });
  if (
    catalog.current.requestLocal !== requestLocal ||
    catalog.current.context !== localContext ||
    catalog.current.workspaceId !== workspaceId
  ) {
    catalog.current = {
      requestLocal,
      context: localContext,
      workspaceId,
      selectionKey,
      input: undefined,
      override: null,
      trail: [],
    };
  } else if (catalog.current.selectionKey !== selectionKey) {
    catalog.current.selectionKey = selectionKey;
    catalog.current.override = null;
  }
  const pageInput: PageInput =
    selection.taskId && catalog.current.override !== selectionKey
      ? { id: selection.taskId, expectedPermitSha256: selection.expectedPermitSha256 ?? null }
      : catalog.current.input;
  const [revision, setRevision] = useState(0);
  const key = allowed
    ? `${workspaceId}:${selection.taskId ?? ''}:${selection.expectedPermitSha256 ?? ''}:${selection.originIncidentId ?? ''}:${connection.current.generation}:${JSON.stringify(pageInput ?? null)}:${revision}`
    : null;
  const routeKey = allowed
    ? `${workspaceId}:${selection.taskId ?? ''}:${selection.expectedPermitSha256 ?? ''}:${selection.originIncidentId ?? ''}:${connection.current.generation}`
    : null;
  const current = useRef({ key, requestLocal });
  current.current = { key, requestLocal };
  const active = useRef<Pending | null>(null);
  const mounted = useRef(false);
  const recheck = useRef<{
    workspaceId: string;
    routeKey: string;
    inputKey: string;
  } | null>(null);
  const unknownRef = useRef(new Map<string, { id: string; permitSha256: string }>());
  const [unknown, setUnknown] = useState<Set<string>>(() => new Set());
  const [capture, setCapture] = useState<{ key: string; page: TaskLockPage } | null>(null);
  const [plan, setPlan] = useState<{ key: string; preview: TaskLockPreview } | null>(null);
  const [ack, setAck] = useState<{ id: string; value: boolean } | null>(null);
  const [completed, setCompleted] = useState<{
    routeKey: string;
    task: TaskLockRow;
    receipt: TaskLockReceipt;
  } | null>(null);
  const [progress, setProgress] = useState<{ key: string; operation: Operation } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const page = key && capture?.key === key ? capture.page : null;
  const state = page?.state ?? null;
  const sourceTask =
    selection.taskId && state
      ? (state.tasks.find((row) => row.id === selection.taskId) ?? null)
      : null;
  const permitMismatch =
    sourceTask !== null &&
    selection.expectedPermitSha256 != null &&
    sourceTask.permitSha256 !== selection.expectedPermitSha256;
  const task = permitMismatch ? null : sourceTask;
  const preview = key && plan?.key === key ? plan.preview : null;
  const receiptMismatch =
    completed?.routeKey === routeKey &&
    sourceTask !== null &&
    (sourceTask.permitSha256 !== completed.receipt.permitSha256 ||
      sourceTask.standing !== 'revoked');
  const completion =
    completed?.routeKey === routeKey && !receiptMismatch && !permitMismatch ? completed : null;
  const receipt = completion?.receipt ?? null;
  const busy = key && progress?.key === key ? progress.operation : null;
  const needsRecheck = workspaceId !== null && unknown.has(workspaceId);
  const unknownTask =
    needsRecheck && workspaceId ? (unknownRef.current.get(workspaceId) ?? null) : null;
  const acknowledged = preview && ack?.id === preview.id ? ack.value : false;
  const latest = useRef({ state, task, preview, acknowledged });
  latest.current = { state, task, preview, acknowledged };
  const clearPreview = useCallback(() => {
    latest.current.preview = null;
    setPlan(null);
    setAck(null);
  }, []);
  const markUnknown = useCallback((ws: string, affected?: { id: string; permitSha256: string }) => {
    if (affected) unknownRef.current.set(ws, affected);
    setUnknown(new Set(unknownRef.current.keys()));
  }, []);
  useEffect(() => {
    setCompleted(null);
  }, [routeKey]);
  const begin = useCallback(
    (operation: Operation) => {
      if (
        !mounted.current ||
        !key ||
        !workspaceId ||
        current.current.key !== key ||
        current.current.requestLocal !== requestLocal ||
        active.current
      )
        return null;
      const controller = new AbortController();
      const record: Pending = { key, workspaceId, operation, controller, timer: undefined! };
      const accepts = () =>
        current.current.key === key &&
        current.current.requestLocal === requestLocal &&
        active.current === record;
      record.timer = setTimeout(() => {
        if (!accepts()) return;
        controller.abort();
        active.current = null;
        setProgress(null);
        clearPreview();
        if (operation === 'apply') markUnknown(workspaceId);
        setFailure({
          key,
          message:
            operation === 'apply'
              ? 'Completion is unknown. Recheck current permissions before another action.'
              : operation === 'preview'
                ? 'Preview timed out. No revocation was requested.'
                : 'Permission inspection timed out. Refresh to retry.',
        });
      }, 25_000);
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
    [key, workspaceId, requestLocal, clearPreview, markUnknown],
  );

  useEffect(() => {
    mounted.current = true;
    current.current = { key, requestLocal };
    setCapture(null);
    clearPreview();
    setFailure(null);
    if (!key || !workspaceId) return;
    const run = begin('load');
    if (!run) return;
    const explicitRecheck =
      recheck.current?.workspaceId === workspaceId &&
      recheck.current.routeKey === routeKey &&
      recheck.current.inputKey === JSON.stringify(pageInput ?? null);
    recheck.current = null;
    void requestLocal('/api/task-locks/page', pageInput, run.record.controller.signal)
      .then((value) => {
        if (!run.valid()) return;
        if (
          !validateTaskLockPage(value) ||
          value.state.workspaceId !== workspaceId ||
          (pageInput &&
            'id' in pageInput &&
            !value.state.tasks.some((row) => row.id === pageInput.id))
        )
          throw new Error();
        setCapture({ key, page: value });
        catalog.current.input = pageInput;
        if (!catalog.current.trail.length || (pageInput && 'id' in pageInput))
          catalog.current.trail = [pageInput];
        const affected = unknownRef.current.get(workspaceId);
        const exactRecheck =
          affected &&
          pageInput &&
          'id' in pageInput &&
          pageInput.id === affected.id &&
          pageInput.expectedPermitSha256 === affected.permitSha256 &&
          value.state.tasks.some(
            (row) => row.id === affected.id && row.permitSha256 === affected.permitSha256,
          );
        if (explicitRecheck && value.state.available && exactRecheck) {
          unknownRef.current.delete(workspaceId);
          setUnknown(new Set(unknownRef.current.keys()));
        }
      })
      .catch((error) => {
        if (run.accepts())
          setFailure({
            key,
            message: taskPageError(error),
          });
      })
      .finally(run.finish);
    return () => {
      mounted.current = false;
      if (current.current.key === key) current.current.key = null;
      const pending = active.current;
      if (pending?.operation === 'apply') markUnknown(pending.workspaceId);
      if (pending) {
        pending.controller.abort();
        clearTimeout(pending.timer);
      }
      active.current = null;
    };
  }, [key, workspaceId, requestLocal, begin, clearPreview, markUnknown]);
  useEffect(() => {
    if (!key || !preview) return;
    const timer = setTimeout(
      () => {
        if (current.current.key !== key || latest.current.preview?.id !== preview.id) return;
        clearPreview();
        setFailure({ key, message: 'Preview expired. Prepare a fresh revocation preview.' });
      },
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [key, preview, clearPreview]);

  const refresh = () => {
    if (
      !key ||
      !workspaceId ||
      current.current.key !== key ||
      current.current.requestLocal !== requestLocal ||
      active.current?.operation === 'apply'
    )
      return;
    if (active.current) {
      active.current.controller.abort();
      clearTimeout(active.current.timer);
      active.current = null;
    }
    clearPreview();
    current.current.key = null;
    recheck.current = routeKey
      ? { workspaceId, routeKey, inputKey: JSON.stringify(pageInput ?? null) }
      : null;
    setRevision((value) => value + 1);
  };
  const navigatePage = (input: PageInput, direction: 'next' | 'back' | 'first' = 'next') => {
    if (
      !key ||
      !workspaceId ||
      current.current.key !== key ||
      current.current.requestLocal !== requestLocal ||
      active.current?.operation === 'apply'
    )
      return;
    if (active.current) {
      active.current.controller.abort();
      clearTimeout(active.current.timer);
      active.current = null;
    }
    clearPreview();
    setCompleted(null);
    current.current.key = null;
    catalog.current.input = input;
    catalog.current.override = selectionKey;
    if (direction === 'back') catalog.current.trail.pop();
    else if (direction === 'first') catalog.current.trail = [undefined];
    else catalog.current.trail.push(input);
    recheck.current = null;
    setRevision((value) => value + 1);
  };
  const prepare = async () => {
    if (
      !state?.available ||
      state !== latest.current.state ||
      !task ||
      latest.current.task !== task ||
      !workspaceId ||
      unknownRef.current.has(workspaceId) ||
      receipt
    )
      return;
    const run = begin('preview');
    if (!run) return;
    clearPreview();
    try {
      const value = await requestLocal(
        '/api/task-locks/preview',
        { id: task.id, expectedPermitSha256: task.permitSha256 },
        run.record.controller.signal,
      );
      if (!run.valid()) return;
      if (
        !validateTaskLockPreview(value) ||
        !taskLockPreviewMatches(value, task, workspaceId) ||
        Date.now() >= Date.parse(value.expiresAt)
      )
        throw new Error();
      setPlan({ key: run.record.key, preview: value });
    } catch {
      if (run.accepts())
        setFailure({
          key: run.record.key,
          message: 'This permission could not be previewed. Refresh before trying again.',
        });
    } finally {
      run.finish();
    }
  };
  const acknowledge = (value: boolean) => {
    if (!preview || latest.current.preview !== preview || active.current?.operation === 'apply')
      return;
    latest.current.acknowledged = value;
    setAck({ id: preview.id, value });
  };
  const apply = async () => {
    if (
      !preview ||
      latest.current.preview !== preview ||
      !workspaceId ||
      unknownRef.current.has(workspaceId) ||
      !latest.current.acknowledged
    )
      return;
    const input = taskLockApplyInput(preview, latest.current.acknowledged);
    if (!input) {
      clearPreview();
      return;
    }
    const run = begin('apply');
    if (!run) return;
    markUnknown(run.record.workspaceId, {
      id: preview.task.id,
      permitSha256: preview.task.permitSha256,
    });
    clearPreview();
    try {
      const value = await requestLocal(
        '/api/task-locks/apply',
        input,
        run.record.controller.signal,
      );
      if (!run.valid()) return;
      if (!validateTaskLockReceipt(value) || !taskLockReceiptMatches(value, preview))
        throw new Error();
      if (!routeKey) throw new Error();
      setCompleted({ routeKey, task: preview.task, receipt: value });
      unknownRef.current.delete(run.record.workspaceId);
      setUnknown(new Set(unknownRef.current.keys()));
      run.finish();
      setRevision((before) => before + 1);
    } catch {
      if (run.accepts()) {
        markUnknown(run.record.workspaceId);
        setCompleted(null);
        setFailure({
          key: run.record.key,
          message:
            'The revocation acknowledgement could not be verified. Recheck current permissions before another action.',
        });
      }
    } finally {
      run.finish();
    }
  };
  const invalidate = () => {
    if (current.current.key !== key || current.current.requestLocal !== requestLocal) return;
    current.current.key = null;
    const pending = active.current;
    if (pending?.operation === 'apply') markUnknown(pending.workspaceId);
    if (pending) {
      pending.controller.abort();
      clearTimeout(pending.timer);
    }
    active.current = null;
    clearPreview();
    setCompleted(null);
  };
  return {
    localAccess,
    workspaceId,
    allowed,
    state,
    page,
    canGoBack: catalog.current.trail.length > 1,
    canResetPage: pageInput !== undefined,
    firstPage: () => navigatePage(undefined, 'first'),
    nextPage: () => {
      if (page?.page.nextCursor) navigatePage({ cursor: page.page.nextCursor });
    },
    previousPage: () => {
      if (catalog.current.trail.length > 1) navigatePage(catalog.current.trail.at(-2), 'back');
    },
    task,
    permitMismatch,
    preview,
    receipt,
    receiptTask: completion?.task ?? null,
    busy,
    needsRecheck,
    unknownTask,
    acknowledged,
    error:
      key && failure?.key === key
        ? failure.message
        : receiptMismatch
          ? 'The current permission no longer matches the revocation receipt. Review the fresh record before another action.'
          : null,
    refresh,
    invalidate,
    prepare,
    acknowledge,
    apply,
  };
}
