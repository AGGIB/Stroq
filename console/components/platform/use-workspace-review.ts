'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import {
  validateWorkspaceReviewState,
  validateWorkspaceReviewReceipt,
  type WorkspaceReviewState,
  type WorkspaceReviewRun,
  type WorkspaceReviewReceipt,
} from '@/lib/workspace-review';
import {
  workspaceReviewCanRecord,
  workspaceReviewInput,
  workspaceReviewReceiptMatches,
  workspaceReviewRunMatches,
} from '@/lib/workspace-review-binding';
import { workspaceReviewError } from '@/lib/workspace-review-errors';
import {
  workspaceReviewReadAllowed,
  workspaceReviewHref,
  type WorkspaceReviewSelection,
} from '@/lib/workspace-review-navigation';
type Operation = 'load' | 'check' | 'cancel' | 'review';
interface Pending {
  key: string;
  workspaceId: string;
  operation: Operation;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

export function useWorkspaceReview(selection: WorkspaceReviewSelection) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
  const allowed = workspaceReviewReadAllowed(selection, workspaceId);
  const selectedKey = allowed ? JSON.stringify([workspaceId, selection.runId]) : null;
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
    active = useRef<Pending | null>(null);
  current.current = key;
  const uncertain = useRef(new Set<string>());
  const [unknown, setUnknown] = useState<Set<string>>(() => new Set());
  const [capture, setCapture] = useState<{ key: string; state: WorkspaceReviewState } | null>(null);
  const [progress, setProgress] = useState<{ key: string; operation: Operation } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [completed, setCompleted] = useState<{
    key: string;
    receipt: WorkspaceReviewReceipt;
  } | null>(null);
  const [ack, setAck] = useState<{ key: string; value: boolean } | null>(null);
  const [pollFailures, setPollFailures] = useState(0);
  const state = key && capture?.key === key ? capture.state : null;
  const run = state
    ? selection.runId
      ? (state.runs.find((value) => value.id === selection.runId) ?? null)
      : (state.runs.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null)
    : null;
  const ackKey =
    key && run?.result
      ? `${key}:${run.id}:${run.result.capture.captureSha256}:${run.result.baseline.revision}`
      : null;
  const acknowledged = ackKey !== null && ack?.key === ackKey ? ack.value : false;
  const busy = key && progress?.key === key ? progress.operation : null;
  const receipt = key && completed?.key === key ? completed.receipt : null;
  const needsRecheck =
    workspaceId !== null &&
    unknown.has(workspaceId) &&
    busy !== 'check' &&
    busy !== 'cancel' &&
    busy !== 'review';
  const latest = useRef({ state, run, acknowledged });
  latest.current = { state, run, acknowledged };
  const markUnknown = useCallback((ws: string, value: boolean) => {
    if (value) uncertain.current.add(ws);
    else uncertain.current.delete(ws);
    setUnknown(new Set(uncertain.current));
  }, []);
  const begin = useCallback(
    (operation: Operation) => {
      if (!mounted.current || !key || !workspaceId || current.current !== key || active.current)
        return null;
      const controller = new AbortController();
      const record: Pending = { key, workspaceId, operation, controller, timer: undefined! };
      const accepts = () => mounted.current && current.current === key && active.current === record;
      record.timer = setTimeout(
        () => {
          if (!accepts()) return;
          controller.abort();
          active.current = null;
          setProgress(null);
          setAck(null);
          if (operation !== 'load') markUnknown(workspaceId, true);
          else setPollFailures((value) => value + 1);
          setFailure({
            key,
            message:
              operation === 'load'
                ? 'Saved workspace checks timed out. Refresh to retry.'
                : 'Completion is unknown. Recheck saved reports before another action.',
          });
        },
        operation === 'review' ? 45_000 : 25_000,
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
    [key, workspaceId, markUnknown],
  );

  const load = useCallback(
    async (poll = false, explicitRecheck = false) => {
      const request = begin('load');
      if (!request || !key || !workspaceId) return;
      if (!poll) {
        setAck(null);
        setPollFailures(0);
      }
      try {
        const value = await requestLocal(
          '/api/workspace-review',
          undefined,
          request.record.controller.signal,
        );
        if (!request.valid()) return;
        if (!validateWorkspaceReviewState(value) || value.workspaceId !== workspaceId)
          throw new Error();
        setCapture({ key, state: value });
        setPollFailures(0);
        if (
          explicitRecheck &&
          value.history.status === 'ready' &&
          value.baseline.status !== 'invalid'
        )
          markUnknown(workspaceId, false);
      } catch (error) {
        if (request.accepts()) {
          setPollFailures((value) => value + 1);
          setFailure({
            key,
            message: workspaceReviewError(
              error,
              'Saved workspace checks are unavailable. No empty result was inferred.',
            ),
          });
        }
      } finally {
        request.finish();
      }
    },
    [begin, key, workspaceId, requestLocal, markUnknown],
  );
  useEffect(() => {
    mounted.current = true;
    setCapture(null);
    setCompleted(null);
    setAck(null);
    setFailure(null);
    setPollFailures(0);
    return () => {
      mounted.current = false;
      const pending = active.current;
      if (pending) {
        pending.controller.abort();
        clearTimeout(pending.timer);
      }
      active.current = null;
    };
  }, [key]);
  useEffect(() => {
    if (key) void load();
  }, [key, load]);
  const running = state?.runs.find((value) => value.status === 'running') ?? null;
  useEffect(() => {
    if (!key || !running || busy || pollFailures >= 3) return;
    const timer = setTimeout(() => void load(true), pollFailures ? 5000 : 1500);
    return () => clearTimeout(timer);
  }, [key, running, busy, pollFailures, load]);

  const check = async () => {
    if (
      !state ||
      latest.current.state !== state ||
      !state.engine.available ||
      state.history.status !== 'ready' ||
      running ||
      !workspaceId ||
      uncertain.current.has(workspaceId)
    )
      return null;
    const request = begin('check');
    if (!request || !key) return null;
    markUnknown(workspaceId, true);
    setAck(null);
    setCompleted(null);
    try {
      const value = await requestLocal(
        '/api/workspace-review/check',
        {},
        request.record.controller.signal,
      );
      if (!request.valid()) return null;
      if (
        !workspaceReviewRunMatches(value, workspaceId) ||
        state.runs.some((old) => old.id === value.id)
      )
        throw new Error();
      setCapture({ key, state: { ...state, runs: [value, ...state.runs].slice(0, 32) } });
      markUnknown(workspaceId, false);
      setPollFailures(0);
      return value;
    } catch (error) {
      if (request.accepts())
        setFailure({
          key,
          message: workspaceReviewError(
            error,
            'The check acknowledgement could not be verified. Recheck saved reports before another action.',
          ),
        });
      return null;
    } finally {
      request.finish();
    }
  };
  const cancel = async () => {
    if (
      !state ||
      latest.current.state !== state ||
      !run ||
      latest.current.run !== run ||
      run.status !== 'running' ||
      !workspaceId ||
      uncertain.current.has(workspaceId)
    )
      return;
    const request = begin('cancel');
    if (!request || !key) return;
    markUnknown(workspaceId, true);
    setAck(null);
    try {
      const value = await requestLocal(
        '/api/workspace-review/cancel',
        { id: run.id },
        request.record.controller.signal,
      );
      if (!request.valid()) return;
      if (!workspaceReviewRunMatches(value, workspaceId, run.id)) throw new Error();
      setCapture({
        key,
        state: { ...state, runs: state.runs.map((old) => (old.id === value.id ? value : old)) },
      });
      markUnknown(workspaceId, false);
      setPollFailures(0);
    } catch (error) {
      if (request.accepts())
        setFailure({
          key,
          message: workspaceReviewError(
            error,
            'Cancellation could not be verified. Recheck the saved attempt.',
          ),
        });
    } finally {
      request.finish();
    }
  };
  const acknowledge = (value: boolean) => {
    if (
      !key ||
      current.current !== key ||
      !mounted.current ||
      !ackKey ||
      !run ||
      latest.current.run !== run ||
      active.current
    )
      return;
    latest.current.acknowledged = value;
    setAck({ key: ackKey, value });
  };
  const review = async () => {
    if (
      !state ||
      !run ||
      latest.current.state !== state ||
      latest.current.run !== run ||
      !workspaceId ||
      uncertain.current.has(workspaceId)
    )
      return;
    const input = workspaceReviewInput(run, state, workspaceId, latest.current.acknowledged);
    if (!input) return;
    const request = begin('review');
    if (!request || !key) return;
    markUnknown(workspaceId, true);
    setAck(null);
    setCompleted(null);
    try {
      const value = await requestLocal(
        '/api/workspace-review/review',
        input,
        request.record.controller.signal,
      );
      if (!request.valid()) return;
      if (
        !validateWorkspaceReviewReceipt(value) ||
        !workspaceReviewReceiptMatches(value, run, workspaceId)
      )
        throw new Error();
      setCompleted({ key, receipt: value });
      markUnknown(workspaceId, false);
      request.finish();
      await load();
    } catch (error) {
      if (request.accepts())
        setFailure({
          key,
          message: workspaceReviewError(
            error,
            'The review acknowledgement could not be verified. Recheck saved reports before another action.',
          ),
        });
    } finally {
      request.finish();
    }
  };
  const getReport = () =>
    mounted.current && key !== null && current.current === key && latest.current.run === run
      ? run
      : null;
  const getRunHref = (value: WorkspaceReviewRun) =>
    mounted.current &&
    key !== null &&
    current.current === key &&
    workspaceId &&
    workspaceReviewRunMatches(value, workspaceId)
      ? workspaceReviewHref(value.id, workspaceId)
      : null;
  return {
    allowed,
    localAccess,
    workspaceId,
    workspaceLabel: localContext?.workspace.label ?? null,
    state,
    run,
    running,
    busy,
    receipt,
    acknowledged,
    needsRecheck,
    pollStopped: pollFailures >= 3,
    error: key && failure?.key === key ? failure.message : null,
    canReview: !receipt && workspaceReviewCanRecord(run, state, workspaceId),
    refresh: () => load(false, true),
    check,
    cancel,
    review,
    acknowledge,
    getReport,
    getRunHref,
  };
}
