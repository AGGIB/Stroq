'use client';
import { useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import type { Incident } from '@/lib/incidents';
import { incidentTaskKey } from '@/lib/incident-task-binding';
import {
  validateTaskAccessPreview,
  validateTaskAccessReceipt,
  validateTaskAccessState,
  TASK_ACCESS_ERROR_MESSAGES,
  type TaskAccessPreview,
  type TaskAccessReceipt,
} from '@/lib/task-access';
import {
  taskAccessIssueInput,
  taskAccessPreviewMatches,
  taskAccessReceiptMatches,
  taskAccessStateMatches,
} from '@/lib/task-access-binding';
type Operation = 'preview' | 'issue' | 'recheck';
type Pending = {
  key: string;
  workspaceId: string;
  operation: Operation;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
};
export function useTaskAccess(incident: Incident | null) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
  const source = incidentTaskKey(incident, workspaceId);
  const identity = useRef({ source, context: localContext, requestLocal, generation: 0 });
  if (
    identity.current.source !== source ||
    identity.current.context !== localContext ||
    identity.current.requestLocal !== requestLocal
  ) {
    identity.current = {
      source,
      context: localContext,
      requestLocal,
      generation: identity.current.generation + 1,
    };
  }
  const contextKey = source ? `${source}:${identity.current.generation}` : null;
  const cycle = useRef(0);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [visible, setVisible] = useState<{ key: string; cycle: number } | null>(null);
  const open = contextKey !== null && visible?.key === contextKey;
  const key = open ? `${contextKey}:${visible!.cycle}` : null;
  const current = useRef({ key, contextKey, requestLocal });
  current.current = { key, contextKey, requestLocal };
  const active = useRef<Pending | null>(null);
  const mounted = useRef(false);
  const unknown = useRef(new Map<string, TaskAccessPreview>());
  const [unknownVersion, setUnknownVersion] = useState(0);
  const [plan, setPlan] = useState<{ key: string; value: TaskAccessPreview } | null>(null);
  const [done, setDone] = useState<{ key: string; value: TaskAccessReceipt } | null>(null);
  const [consent, setConsent] = useState({ id: '', oneUse: false, signingKey: false });
  const [progress, setProgress] = useState<{ key: string; operation: Operation } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [notice, setNotice] = useState<{ key: string; message: string } | null>(null);
  const preview = key && plan?.key === key ? plan.value : null,
    receipt = key && done?.key === key ? done.value : null;
  const ack =
    preview && consent.id === preview.id ? consent : { id: '', oneUse: false, signingKey: false };
  const latest = useRef({ preview, ack });
  latest.current = { preview, ack };
  const accepted = useRef<{ key: string; receipt: TaskAccessReceipt } | null>(null);
  const clear = () => {
    latest.current = { preview: null, ack: { id: '', oneUse: false, signingKey: false } };
    setPlan(null);
    setConsent({ id: '', oneUse: false, signingKey: false });
  };
  const markUnknown = (ws: string, p: TaskAccessPreview) => {
    unknown.current.set(ws, p);
    setUnknownVersion((v) => v + 1);
  };
  useEffect(() => {
    mounted.current = true;
    clear();
    setDone(null);
    setFailure(null);
    setNotice(null);
    setProgress(null);
    accepted.current = null;
    return () => {
      mounted.current = false;
      const pending = active.current;
      if (pending) {
        pending.controller.abort();
        clearTimeout(pending.timer);
      }
      active.current = null;
      accepted.current = null;
    };
  }, [key]);
  const begin = (operation: Operation) => {
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
    const pending: Pending = { key, workspaceId, operation, controller, timer: undefined! };
    const accepts = () =>
      current.current.key === key &&
      current.current.requestLocal === requestLocal &&
      active.current === pending;
    pending.timer = setTimeout(() => {
      if (!accepts()) return;
      controller.abort();
      active.current = null;
      clear();
      setProgress(null);
      setFailure({
        key,
        message:
          operation === 'issue'
            ? 'Issue completion is unknown. Recheck existing permissions before another action.'
            : 'The request timed out. No new result was accepted.',
      });
    }, 25000);
    active.current = pending;
    setProgress({ key, operation });
    setFailure(null);
    setNotice(null);
    return {
      pending,
      accepts,
      valid: () => accepts() && !controller.signal.aborted,
      finish: () => {
        clearTimeout(pending.timer);
        if (active.current === pending) {
          active.current = null;
          setProgress(null);
        }
      },
    };
  };
  const prepare = async () => {
    if (!incident || !workspaceId || unknown.current.has(workspaceId) || receipt) return;
    const run = begin('preview');
    if (!run) return;
    clear();
    try {
      const value = await requestLocal(
        '/api/task-locks/access/preview',
        { id: incident.id, expectedEvidenceSha: incident.evidenceSha },
        run.pending.controller.signal,
      );
      if (!run.valid()) return;
      if (
        !validateTaskAccessPreview(value) ||
        !taskAccessPreviewMatches(value, incident, workspaceId) ||
        Date.now() >= Date.parse(value.expiresAt)
      )
        throw new Error();
      setPlan({ key: run.pending.key, value });
    } catch (error) {
      if (run.accepts()) {
        const fixed =
          error instanceof Error &&
          Object.values(TASK_ACCESS_ERROR_MESSAGES).includes(error.message)
            ? error.message
            : 'This finding has no verifiable one-use preview.';
        setFailure({ key: run.pending.key, message: fixed });
      }
    } finally {
      run.finish();
    }
  };
  const acknowledge = (field: 'oneUse' | 'signingKey', value: boolean) => {
    if (
      !preview ||
      latest.current.preview !== preview ||
      active.current?.operation === 'issue' ||
      current.current.key !== key
    )
      return;
    const next = { ...latest.current.ack, id: preview.id, [field]: value };
    latest.current.ack = next;
    setConsent(next);
  };
  const issue = async () => {
    if (
      !preview ||
      latest.current.preview !== preview ||
      !workspaceId ||
      unknown.current.has(workspaceId)
    )
      return;
    const input = taskAccessIssueInput(
      preview,
      latest.current.ack.oneUse,
      latest.current.ack.signingKey,
    );
    if (!input) {
      clear();
      return;
    }
    const run = begin('issue');
    if (!run) return;
    markUnknown(workspaceId, preview);
    clear();
    try {
      const value = await requestLocal(
        '/api/task-locks/access/issue',
        input,
        run.pending.controller.signal,
      );
      if (!run.valid()) return;
      if (!validateTaskAccessReceipt(value) || !taskAccessReceiptMatches(value, preview))
        throw new Error();
      unknown.current.delete(workspaceId);
      setUnknownVersion((v) => v + 1);
      accepted.current = { key: run.pending.key, receipt: value };
      setDone({ key: run.pending.key, value });
    } catch {
      if (run.accepts())
        setFailure({
          key: run.pending.key,
          message:
            'Issue completion is unknown. Recheck existing permissions before another action.',
        });
    } finally {
      run.finish();
    }
  };
  const recheck = async () => {
    if (!workspaceId) return;
    const attempt = unknown.current.get(workspaceId);
    if (!attempt) return;
    const run = begin('recheck');
    if (!run) return;
    clear();
    try {
      const value = await requestLocal(
        `/api/task-locks/access/${attempt.task.id}/${attempt.task.permitSha256}`,
        undefined,
        run.pending.controller.signal,
      );
      if (!run.valid()) return;
      if (
        !validateTaskAccessState(value) ||
        !taskAccessStateMatches(value, workspaceId, attempt.task.id, attempt.task.permitSha256) ||
        !value.coverage.complete
      )
        throw new Error();
      unknown.current.delete(workspaceId);
      setUnknownVersion((v) => v + 1);
      setNotice({
        key: run.pending.key,
        message: 'Existing permissions rechecked. Prepare a fresh preview before another issue.',
      });
    } catch {
      if (run.accepts())
        setFailure({
          key: run.pending.key,
          message:
            'Existing permissions could not be fully verified. Issue completion remains unknown.',
        });
    } finally {
      run.finish();
    }
  };
  useEffect(() => {
    if (!key || !preview) return;
    const timer = setTimeout(
      () => {
        if (current.current.key !== key || latest.current.preview !== preview) return;
        clear();
        setFailure({ key, message: 'Preview expired. Prepare it again.' });
      },
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [key, preview]);
  const busy = key && progress?.key === key ? progress.operation : null;
  return {
    workspaceId,
    trigger,
    open,
    preview,
    receipt,
    oneUse: ack.oneUse,
    signingKey: ack.signingKey,
    busy,
    error: key && failure?.key === key ? failure.message : null,
    message: key && notice?.key === key ? notice.message : null,
    needsRecheck: workspaceId !== null && unknown.current.has(workspaceId) && busy !== 'issue',
    unknownVersion,
    openReview: () => {
      if (
        mounted.current &&
        contextKey &&
        current.current.contextKey === contextKey &&
        current.current.requestLocal === requestLocal
      )
        setVisible({ key: contextKey, cycle: ++cycle.current });
    },
    close: () => {
      if (!mounted.current || current.current.key !== key) return;
      current.current.key = null;
      const pending = active.current;
      if (pending) {
        pending.controller.abort();
        clearTimeout(pending.timer);
      }
      active.current = null;
      accepted.current = null;
      clear();
      setDone(null);
      setProgress(null);
      setVisible(null);
    },
    prepare,
    acknowledge,
    issue,
    recheck,
    getReceipt: () =>
      mounted.current && key && current.current.key === key && accepted.current?.key === key
        ? accepted.current.receipt
        : null,
  };
}
