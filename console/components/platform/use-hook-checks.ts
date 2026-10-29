'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import type { AgentId } from '@/lib/agent-status';
import {
  validateHookCheckJob,
  validateHookCheckPreview,
  validateHookCheckState,
  type HookCheckJob,
  type HookCheckPreview,
  type HookCheckScope,
  type HookCheckState,
} from '@/lib/hook-checks';
import {
  hookCheckJobMatches,
  hookCheckPreviewMatches,
  hookCheckSelectionKey,
  hookCheckStartInput,
  hookCheckStartMatches,
  hookCheckSourceMatches,
  scopedHookCheckJobs,
} from '@/lib/hook-check-binding';

type Operation = 'load' | 'recheck' | 'preview' | 'start' | 'poll' | 'cancel';
interface Pending {
  key: string;
  identity: string;
  operation: Operation;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

export function useHookChecks({
  open,
  agent,
  scope,
  generation = 0,
  expectedWorkspaceId,
  expectedSourceSha256,
  selectedJobId,
}: {
  open: boolean;
  agent: AgentId;
  scope: HookCheckScope;
  generation?: number;
  expectedWorkspaceId?: string;
  expectedSourceSha256?: string;
  selectedJobId?: string;
}) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
  const selectionKey = hookCheckSelectionKey(workspaceId, agent, scope, generation);
  const identity = workspaceId && selectionKey ? `${workspaceId}:${agent}:${scope}` : null;
  const contextMismatch = expectedWorkspaceId !== undefined && expectedWorkspaceId !== workspaceId;
  const invalidConstraints =
    (expectedSourceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSourceSha256)) ||
    (selectedJobId !== undefined &&
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(selectedJobId));
  const target =
    selectionKey && !contextMismatch && !invalidConstraints
      ? JSON.stringify([selectionKey, expectedWorkspaceId, expectedSourceSha256, selectedJobId])
      : null;
  const connection = useRef({ requestLocal, context: localContext, target, open, version: 0 });
  if (
    connection.current.requestLocal !== requestLocal ||
    connection.current.context !== localContext ||
    connection.current.target !== target ||
    connection.current.open !== open
  ) {
    connection.current = {
      requestLocal,
      context: localContext,
      target,
      open,
      version: connection.current.version + 1,
    };
  }
  const key = open && target ? `${target}:${connection.current.version}` : null;
  const current = useRef({ key, requestLocal });
  current.current = { key, requestLocal };
  const mounted = useRef(false);
  const active = useRef<Pending | null>(null);
  const unknownRef = useRef(new Set<string>());
  const [unknown, setUnknown] = useState<Set<string>>(() => new Set());
  const [stateCapture, setStateCapture] = useState<{ key: string; value: HookCheckState } | null>(
    null,
  );
  const [previewCapture, setPreviewCapture] = useState<{
    key: string;
    value: HookCheckPreview;
  } | null>(null);
  const [jobCapture, setJobCapture] = useState<{ key: string; value: HookCheckJob } | null>(null);
  const [missingCapture, setMissingCapture] = useState<string | null>(null);
  const [sourceMismatchKey, setSourceMismatchKey] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ key: string; value: Operation } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [pollFailure, setPollFailure] = useState<{ key: string; count: number } | null>(null);
  const state = key && stateCapture?.key === key ? stateCapture.value : null;
  const preview = key && previewCapture?.key === key ? previewCapture.value : null;
  const job = key && jobCapture?.key === key ? jobCapture.value : null;
  const busy = key && progress?.key === key ? progress.value : null;
  const pollFailures = key && pollFailure?.key === key ? pollFailure.count : 0;
  const needsRecheck = identity !== null && unknown.has(identity);
  const selection = workspaceId ? { workspaceId, agent, scope } : null;
  const jobs = state && selection ? scopedHookCheckJobs(state.jobs, selection) : [];
  const latest = useRef({ state, preview, job, jobs });
  latest.current = { state, preview, job, jobs };
  const clearPreview = useCallback(() => {
    latest.current.preview = null;
    setPreviewCapture(null);
  }, []);
  const markUnknown = useCallback((selected: string) => {
    unknownRef.current.add(selected);
    setUnknown(new Set(unknownRef.current));
  }, []);

  const begin = useCallback(
    (operation: Operation) => {
      if (
        !mounted.current ||
        !key ||
        !identity ||
        current.current.key !== key ||
        current.current.requestLocal !== requestLocal ||
        active.current
      )
        return null;
      const controller = new AbortController();
      const record: Pending = { key, identity, operation, controller, timer: undefined! };
      const accepts = () =>
        mounted.current &&
        current.current.key === key &&
        current.current.requestLocal === requestLocal &&
        active.current === record;
      record.timer = setTimeout(
        () => {
          if (!accepts()) return;
          controller.abort();
          active.current = null;
          setProgress(null);
          if (operation === 'start' || operation === 'cancel') markUnknown(identity);
          if (operation === 'poll')
            setPollFailure((before) => ({
              key,
              count: before?.key === key ? before.count + 1 : 1,
            }));
          clearPreview();
          setFailure({
            key,
            message:
              operation === 'start' || operation === 'cancel'
                ? 'No acknowledgement received. The test may still be running. Recheck history before another action.'
                : operation === 'poll'
                  ? 'Updates timed out. The test may still be running.'
                  : operation === 'preview'
                    ? 'Preview timed out. No test was started.'
                    : 'Hook-check history timed out. Refresh to retry.',
          });
        },
        operation === 'poll' ? 12_000 : 25_000,
      );
      active.current = record;
      setProgress({ key, value: operation });
      if (operation !== 'poll') setFailure(null);
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
    [key, identity, requestLocal, markUnknown, clearPreview],
  );

  const recordJob = useCallback((value: HookCheckJob, selectedKey: string) => {
    latest.current.job = value;
    setJobCapture({ key: selectedKey, value });
    setMissingCapture(null);
    setStateCapture((before) =>
      before?.key === selectedKey
        ? {
            ...before,
            value: {
              ...before.value,
              jobs: [value, ...before.value.jobs.filter((item) => item.id !== value.id)]
                .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))
                .slice(0, 32),
            },
          }
        : before,
    );
  }, []);

  const load = useCallback(
    async (recheck = false) => {
      const run = begin(recheck ? 'recheck' : 'load');
      if (!run || !workspaceId) return;
      clearPreview();
      try {
        const value = await requestLocal(
          '/api/hook-checks',
          undefined,
          run.record.controller.signal,
        );
        if (!run.valid()) return;
        if (!validateHookCheckState(value) || value.workspaceId !== workspaceId) throw new Error();
        setStateCapture({ key: run.record.key, value });
        setPollFailure(null);
        const previous = latest.current.job;
        if (previous || selectedJobId) {
          const next = previous
            ? value.jobs.find((item) => hookCheckJobMatches(item, previous))
            : value.jobs.find(
                (item) =>
                  item.id === selectedJobId &&
                  item.binding.agent === agent &&
                  item.binding.scope === scope,
              );
          latest.current.job = next ?? null;
          setJobCapture(next ? { key: run.record.key, value: next } : null);
          setMissingCapture(next ? null : run.record.key);
        }
        if (recheck && value.history.status !== 'error') {
          unknownRef.current.delete(run.record.identity);
          setUnknown(new Set(unknownRef.current));
        }
        setFailure(
          value.history.status === 'error'
            ? {
                key: run.record.key,
                message:
                  'Retained history is unavailable. No completion claim can be made for a missing attempt.',
              }
            : null,
        );
      } catch {
        if (run.accepts())
          setFailure({
            key: run.record.key,
            message: 'Hook-check history could not be read. Earlier results remain historical.',
          });
      } finally {
        run.finish();
      }
    },
    [begin, workspaceId, requestLocal, clearPreview, selectedJobId, agent, scope],
  );

  useEffect(() => {
    mounted.current = true;
    setStateCapture(null);
    clearPreview();
    setJobCapture(null);
    setMissingCapture(null);
    setSourceMismatchKey(null);
    setPollFailure(null);
    setFailure(null);
    if (key) void load();
    return () => {
      mounted.current = false;
      const pending = active.current;
      if (pending?.operation === 'start' || pending?.operation === 'cancel')
        markUnknown(pending.identity);
      if (pending) {
        pending.controller.abort();
        clearTimeout(pending.timer);
      }
      active.current = null;
    };
  }, [key, load, markUnknown, clearPreview]);

  useEffect(() => {
    if (!key || !preview) return;
    const timer = setTimeout(
      () => {
        if (!mounted.current || current.current.key !== key) return;
        if (latest.current.preview?.id !== preview.id) return;
        clearPreview();
        setFailure({ key, message: 'Preview expired. Prepare a fresh preview before starting.' });
      },
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [key, preview, clearPreview]);

  const poll = useCallback(
    async (selected: HookCheckJob) => {
      if (!latest.current.job || !hookCheckJobMatches(latest.current.job, selected)) return;
      const run = begin('poll');
      if (!run) return;
      try {
        const value = await requestLocal(
          `/api/hook-checks/jobs/${selected.id}`,
          undefined,
          run.record.controller.signal,
        );
        if (!run.valid()) return;
        if (!validateHookCheckJob(value) || !hookCheckJobMatches(value, selected))
          throw new Error();
        recordJob(value, run.record.key);
        setPollFailure(null);
        setFailure(null);
      } catch {
        if (run.accepts()) {
          setPollFailure((before) => ({
            key: run.record.key,
            count: before?.key === run.record.key ? before.count + 1 : 1,
          }));
          setFailure({
            key: run.record.key,
            message: 'The running test could not be refreshed. Reconnect to read its result.',
          });
        }
      } finally {
        run.finish();
      }
    },
    [begin, requestLocal, recordJob],
  );
  useEffect(() => {
    if (!key || busy || job?.status !== 'running' || pollFailures >= 3) return;
    const timer = setTimeout(() => void poll(job), 1000 * (pollFailures + 1));
    return () => clearTimeout(timer);
  }, [key, job, pollFailures, poll, busy]);

  const prepare = async () => {
    if (
      !state?.engine.available ||
      latest.current.state !== state ||
      !state.agents.find((item) => item.id === agent)?.supported ||
      !workspaceId ||
      !identity ||
      unknownRef.current.has(identity) ||
      state.jobs.some((item) => item.status === 'running')
    )
      return;
    const run = begin('preview');
    if (!run) return;
    clearPreview();
    setSourceMismatchKey(null);
    setJobCapture(null);
    setMissingCapture(null);
    try {
      const value = await requestLocal(
        '/api/hook-checks/preview',
        { agent, scope },
        run.record.controller.signal,
      );
      if (!run.valid()) return;
      if (
        !validateHookCheckPreview(value) ||
        !hookCheckPreviewMatches(value, { workspaceId, agent, scope }) ||
        Date.now() >= Date.parse(value.expiresAt)
      )
        throw new Error();
      if (!hookCheckSourceMatches(value, expectedSourceSha256)) {
        setSourceMismatchKey(run.record.key);
        setFailure({
          key: run.record.key,
          message:
            'Hook source changed after setup. Open current agent settings before testing a different source.',
        });
        return;
      }
      setPreviewCapture({ key: run.record.key, value });
    } catch {
      if (run.accepts())
        setFailure({
          key: run.record.key,
          message:
            'A current hook preview could not be prepared. Recheck configuration and try again.',
        });
    } finally {
      run.finish();
    }
  };

  const start = async () => {
    if (
      !preview ||
      latest.current.preview !== preview ||
      !hookCheckSourceMatches(preview, expectedSourceSha256) ||
      !identity ||
      unknownRef.current.has(identity)
    )
      return;
    const input = hookCheckStartInput(preview);
    if (!input) {
      clearPreview();
      return;
    }
    const run = begin('start');
    if (!run) return;
    clearPreview();
    try {
      const value = await requestLocal(
        '/api/hook-checks/start',
        input,
        run.record.controller.signal,
      );
      if (!run.valid()) return;
      if (!validateHookCheckJob(value) || !hookCheckStartMatches(value, preview)) throw new Error();
      recordJob(value, run.record.key);
      setPollFailure(null);
    } catch {
      if (run.accepts()) {
        markUnknown(run.record.identity);
        setFailure({
          key: run.record.key,
          message:
            'The start acknowledgement could not be verified. Recheck history before another test.',
        });
      }
    } finally {
      run.finish();
    }
  };

  const cancel = async () => {
    if (
      !job ||
      latest.current.job !== job ||
      job.status !== 'running' ||
      !identity ||
      unknownRef.current.has(identity) ||
      current.current.key !== key
    )
      return;
    if (active.current?.operation === 'poll') {
      active.current.controller.abort();
      clearTimeout(active.current.timer);
      active.current = null;
      setProgress(null);
    }
    const run = begin('cancel');
    if (!run) return;
    try {
      const value = await requestLocal(
        '/api/hook-checks/cancel',
        { jobId: job.id },
        run.record.controller.signal,
      );
      if (!run.valid()) return;
      if (!validateHookCheckJob(value) || !hookCheckJobMatches(value, job)) throw new Error();
      recordJob(value, run.record.key);
      setPollFailure(null);
    } catch {
      if (run.accepts()) {
        markUnknown(run.record.identity);
        setFailure({
          key: run.record.key,
          message: 'Cancellation is unconfirmed. Recheck history; the test may still be running.',
        });
      }
    } finally {
      run.finish();
    }
  };

  const refresh = () => {
    if (!mounted.current || current.current.key !== key) return;
    if (active.current?.operation === 'poll') {
      active.current.controller.abort();
      clearTimeout(active.current.timer);
      active.current = null;
    }
    void load(true);
  };
  const selectJob = (value: HookCheckJob) => {
    if (
      !mounted.current ||
      !key ||
      current.current.key !== key ||
      (active.current && active.current.operation !== 'poll') ||
      !latest.current.jobs.some((item) => hookCheckJobMatches(item, value))
    )
      return;
    if (active.current) {
      active.current.controller.abort();
      clearTimeout(active.current.timer);
      active.current = null;
      setProgress(null);
    }
    clearPreview();
    latest.current.job = value;
    setJobCapture({ key, value });
    setMissingCapture(null);
    setPollFailure(null);
    setFailure(null);
  };
  const invalidate = () => {
    if (!mounted.current || current.current.key !== key) return;
    current.current = { key: null, requestLocal };
    connection.current.version += 1;
    const pending = active.current;
    if (pending?.operation === 'start' || pending?.operation === 'cancel')
      markUnknown(pending.identity);
    if (pending) {
      pending.controller.abort();
      clearTimeout(pending.timer);
    }
    active.current = null;
    clearPreview();
    setProgress(null);
  };
  return {
    workspaceId,
    state,
    preview,
    job,
    jobs,
    busy,
    needsRecheck,
    pollFailures,
    sourceMismatch: key !== null && sourceMismatchKey === key,
    contextMismatch,
    gap: invalidConstraints || (key !== null && missingCapture === key),
    missingSelection: key !== null && missingCapture === key,
    error: key && failure?.key === key ? failure.message : null,
    prepare,
    start,
    cancel,
    refresh,
    selectJob,
    invalidate,
  };
}
