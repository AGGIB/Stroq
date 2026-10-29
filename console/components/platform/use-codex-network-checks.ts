'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  validateCodexNetworkCheckState,
  validateCodexNetworkCheckJob,
  type CodexNetworkCheckState,
  type CodexNetworkCheckPreview,
  type CodexNetworkCheckJob,
} from '@/lib/codex-network-check';
import {
  codexNetworkCheckPending,
  codexNetworkGuardPending,
  checkPreviewMatches,
  checkJobMatches,
  confirmNetworkCheck,
  networkBindingMatches,
  networkPendingKey,
  notifyCodexNetworkPending,
  subscribeCodexNetworkPending,
  NETWORK_PENDING_LIMIT,
  networkCheckAdmissionPendingMatches,
  networkCheckOwned,
  CodexNetworkCheckStartRefusal,
} from '@/lib/codex-network-client';
import type { CodexNetworkSession } from './use-codex-network-session';
import type { CodexNetworkGuardAction } from './use-codex-network-guard';
export function useCodexNetworkChecks(
  session: CodexNetworkSession,
  guard: CodexNetworkGuardAction,
) {
  const { key, workspaceId, requestLocal, begin, fail } = session;
  const [saved, setSaved] = useState<{ key: string; value: CodexNetworkCheckState } | null>(null),
    [planned, setPlanned] = useState<{ key: string; value: CodexNetworkCheckPreview } | null>(null),
    [selected, setSelected] = useState<{ key: string; value: CodexNetworkCheckJob } | null>(null),
    [pollFailure, setPollFailure] = useState<{ key: string; count: number } | null>(null);
  const [, changed] = useState(0);
  const state = key && saved?.key === key ? saved.value : null,
    preview = key && planned?.key === key ? planned.value : null,
    job = key && selected?.key === key ? selected.value : null,
    pollFailures = key && pollFailure?.key === key ? pollFailure.count : 0;
  const latest = useRef({ state, preview, job });
  latest.current = { state, preview, job };
  const clearPreview = useCallback(() => {
    latest.current.preview = null;
    setPlanned(null);
  }, []);
  const guardRead = guard.read;
  useEffect(
    () => subscribeCodexNetworkPending(requestLocal, () => changed((n) => n + 1)),
    [requestLocal],
  );
  useEffect(() => {
    clearPreview();
  }, [key, guard.capture?.binding?.captureSha256, clearPreview]);
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(
      () => {
        clearPreview();
        fail('Check preview expired. Prepare another review.');
      },
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [preview, key, clearPreview, fail]);
  const pendingHere = () =>
    [...codexNetworkCheckPending(requestLocal).values()].filter(
      (p) =>
        p.binding.workspaceId === workspaceId &&
        p.binding.controlContextId === guardRead().state?.controlContextId,
    );
  const blocked = () => {
    const { state: s } = guardRead();
    return (
      !s?.controlContextId ||
      s.records.some((r) => r.operationStatus === 'unknown') ||
      [...codexNetworkGuardPending(requestLocal).values()].some(
        (w) => w.preview.controlContextId === s.controlContextId,
      ) ||
      !networkCheckAdmissionPendingMatches(
        latest.current.state,
        [...codexNetworkCheckPending(requestLocal).values()],
        s.controlContextId,
        workspaceId,
      ) ||
      codexNetworkCheckPending(requestLocal).size >= NETWORK_PENDING_LIMIT
    );
  };
  const mergeJob = useCallback(
    (value: CodexNetworkCheckJob) => {
      if (!key) return;
      latest.current.job = value;
      setSelected({ key, value });
      setSaved((previous) =>
        previous?.key === key
          ? {
              key,
              value: {
                ...previous.value,
                jobs: [
                  value,
                  ...previous.value.jobs.filter(
                    (j) =>
                      j.id !== value.id && (value.status !== 'running' || j.status !== 'running'),
                  ),
                ].slice(0, 32),
                activeJobId:
                  value.status === 'running'
                    ? value.id
                    : previous.value.activeJobId === value.id
                      ? null
                      : previous.value.activeJobId,
                ownedJobId:
                  value.status === 'running'
                    ? value.id
                    : previous.value.ownedJobId === value.id
                      ? null
                      : previous.value.ownedJobId,
              },
            }
          : previous,
      );
    },
    [key],
  );
  const refresh = useCallback(
    async (explicit = false, poll = false) => {
      const timeout = () => {
        if (key && poll) setPollFailure((p) => ({ key, count: p?.key === key ? p.count + 1 : 1 }));
      };
      const run = begin(poll ? 'check-poll' : 'check-load', timeout);
      if (!run || !key || !workspaceId) return false;
      try {
        const value = await requestLocal('/api/codex-network-checks', undefined, run.signal);
        if (!run.accepts()) return false;
        if (
          !validateCodexNetworkCheckState(value) ||
          value.workspaceId !== workspaceId ||
          (value.controlContextId !== null &&
            guardRead().state?.controlContextId &&
            value.controlContextId !== guardRead().state?.controlContextId)
        )
          throw Error();
        setSaved({ key, value });
        setPollFailure({ key, count: 0 });
        if (explicit)
          for (const candidate of value.jobs)
            if (candidate.binding.controlContextId === value.controlContextId)
              confirmNetworkCheck(requestLocal, candidate);
        const previous = latest.current.job;
        const next = previous
          ? value.jobs.find(
              (j) =>
                j.id === previous.id &&
                j.operationId === previous.operationId &&
                checkJobMatches(j, previous),
            )
          : (value.jobs.find((j) => j.id === value.activeJobId) ?? value.jobs[0]);
        if (next) {
          latest.current.job = next;
          setSelected({ key, value: next });
        }
        return true;
      } catch (error) {
        if (run.accepts()) {
          if (poll) timeout();
          fail(
            poll
              ? 'Check updates could not be verified.'
              : 'Native check history could not be verified.',
            error,
          );
        }
        return false;
      } finally {
        run.finish();
      }
    },
    [begin, key, workspaceId, requestLocal, guardRead, fail],
  );
  const prepare = useCallback(async () => {
    const capture = guardRead().capture;
    if (
      !capture?.canCheck ||
      !capture.binding ||
      blocked() ||
      latest.current.state?.history !== 'ready' ||
      latest.current.state.ownedJobId
    ) {
      fail('Inspect a supported network-off default and recheck unfinished operations first.');
      return;
    }
    const run = begin('check-preview');
    if (!run || !key || !workspaceId) return;
    clearPreview();
    try {
      const value = await requestLocal(
        '/api/codex-network-checks/preview',
        {
          controlContextId: capture.binding.controlContextId,
          captureSha256: capture.binding.captureSha256,
        },
        run.signal,
      );
      if (!run.accepts()) return;
      if (!checkPreviewMatches(value, capture, workspaceId)) throw Error();
      setPlanned({ key, value });
    } catch (error) {
      if (run.accepts()) fail('The exact copied-policy check could not be previewed.', error);
    } finally {
      run.finish();
    }
  }, [begin, key, workspaceId, requestLocal, guardRead, clearPreview, fail]);
  const start = useCallback(async () => {
    const p = latest.current.preview,
      capture = guardRead().capture;
    if (
      !p ||
      !capture ||
      !workspaceId ||
      !checkPreviewMatches(p, capture, workspaceId) ||
      blocked() ||
      latest.current.state?.ownedJobId
    )
      return;
    const run = begin('check-start');
    if (!run || !key) return;
    const intent = {
      action: 'start' as const,
      id: p.jobId,
      operationId: p.operationId,
      binding: p.binding,
      startedAt: new Date().toISOString(),
    };
    codexNetworkCheckPending(requestLocal).set(
      networkPendingKey(p.binding.controlContextId, p.jobId),
      intent,
    );
    notifyCodexNetworkPending(requestLocal);
    clearPreview();
    try {
      const value = await requestLocal(
        '/api/codex-network-checks/start',
        { previewId: p.id, controlContextId: p.binding.controlContextId },
        run.signal,
      );
      if (!run.accepts()) return;
      if (!checkJobMatches(value, intent)) throw Error();
      mergeJob(value);
      confirmNetworkCheck(requestLocal, value);
    } catch (error) {
      if (run.accepts()) {
        if (error instanceof CodexNetworkCheckStartRefusal) {
          const pending = codexNetworkCheckPending(requestLocal),
            key = networkPendingKey(p.binding.controlContextId, p.jobId);
          if (pending.get(key) === intent) {
            pending.delete(key);
            notifyCodexNetworkPending(requestLocal);
          }
          fail(error.message);
        } else
          fail('Check start is unconfirmed. Recheck this exact attempt; do not start it again.');
      }
    } finally {
      run.finish();
    }
  }, [begin, key, workspaceId, requestLocal, guardRead, clearPreview, fail, mergeJob]);
  const cancel = useCallback(async () => {
    const j = latest.current.job;
    if (
      !j ||
      j.status !== 'running' ||
      j.binding.workspaceId !== workspaceId ||
      j.binding.controlContextId !== guardRead().state?.controlContextId ||
      !networkCheckOwned(
        latest.current.state,
        j,
        guardRead().state?.controlContextId,
        workspaceId,
      ) ||
      pendingHere().some((p) => checkJobMatches(j, p))
    )
      return;
    const run = begin('check-cancel');
    if (!run || !key) return;
    const intent = {
      action: 'cancel' as const,
      id: j.id,
      operationId: j.operationId,
      binding: j.binding,
      startedAt: new Date().toISOString(),
    };
    codexNetworkCheckPending(requestLocal).set(
      networkPendingKey(j.binding.controlContextId, j.id),
      intent,
    );
    notifyCodexNetworkPending(requestLocal);
    try {
      const value = await requestLocal(
        '/api/codex-network-checks/cancel',
        { jobId: j.id, controlContextId: j.binding.controlContextId, operationId: j.operationId },
        run.signal,
      );
      if (!run.accepts()) return;
      if (!checkJobMatches(value, intent)) throw Error();
      mergeJob(value);
      confirmNetworkCheck(requestLocal, value);
      if (value.status === 'running')
        fail('Cancellation is unconfirmed. Recheck the exact attempt.');
    } catch {
      if (run.accepts()) fail('Cancellation is unconfirmed. Recheck the exact attempt.');
    } finally {
      run.finish();
    }
  }, [begin, key, workspaceId, requestLocal, guardRead, fail, mergeJob]);
  const all = [...codexNetworkCheckPending(requestLocal).values()],
    context = guard.state?.controlContextId;
  const pending = all.filter(
    (p) =>
      p.binding.workspaceId === workspaceId && (!context || p.binding.controlContextId === context),
  );
  const currentOwned = networkCheckOwned(state, job, context, workspaceId);
  const pendingForJob = !!job && pending.some((p) => checkJobMatches(job, p));
  useEffect(() => {
    if (!key || !currentOwned || session.busy || pollFailures >= 3 || pendingForJob) return;
    const timer = setTimeout(() => void refresh(false, true), 1500);
    return () => clearTimeout(timer);
  }, [key, job, currentOwned, session.busy, pollFailures, pendingForJob, refresh]);
  const selectJob = useCallback(
    (id: string) => {
      const value = latest.current.state?.jobs.find((j) => j.id === id);
      if (value && key && validateCodexNetworkCheckJob(value)) setSelected({ key, value });
    },
    [key],
  );
  return {
    state,
    preview,
    job,
    pollFailures,
    refresh,
    prepare,
    start,
    cancel,
    selectJob,
    clearPreview,
    pending,
    currentOwned,
    canCancel: currentOwned && !session.isBusy() && !pendingForJob,
    canPrepare:
      !!guard.capture?.canCheck &&
      !!guard.capture.binding &&
      state?.history === 'ready' &&
      !state.ownedJobId &&
      !blocked(),
    foreignPending: all.filter(
      (p) =>
        p.binding.workspaceId !== workspaceId ||
        (context && p.binding.controlContextId !== context),
    ),
    canStart:
      !!preview &&
      !session.isBusy() &&
      !!guard.capture &&
      !!workspaceId &&
      checkPreviewMatches(preview, guard.capture, workspaceId) &&
      !blocked() &&
      !state?.ownedJobId,
    currentProof:
      !!job &&
      job.binding.workspaceId === workspaceId &&
      !!guard.capture?.binding &&
      networkBindingMatches(job.binding, guard.capture.binding),
  };
}
export type CodexNetworkCheckAction = ReturnType<typeof useCodexNetworkChecks>;
