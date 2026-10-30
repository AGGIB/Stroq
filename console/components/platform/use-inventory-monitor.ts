'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import {
  validateInventoryMonitorState,
  validateInventoryMonitorPreview,
  validateInventoryMonitorReceipt,
  type InventoryMonitorState,
  type InventoryMonitorPreview,
} from '@/lib/inventory-monitor';

type Operation = 'load' | 'preview' | 'apply';
type Action = 'enable' | 'pause';
type Transport = (path: string, body?: unknown, signal?: AbortSignal) => Promise<unknown>;
type Attempt = { runtimeSha256: string; previewId: string; action: Action };
// An uncertain write outlives its page. A transport replacement isolates another connection;
// returning to the original connection still requires an explicit, exact state read.
const uncertainWrites = new WeakMap<Transport, Map<string, Attempt>>();
function attempts(transport: Transport) {
  let value = uncertainWrites.get(transport);
  if (!value) {
    value = new Map();
    uncertainWrites.set(transport, value);
  }
  return value;
}
interface Pending {
  key: string;
  operation: Operation;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}
export function useInventoryMonitor({
  enabled = true,
  canRefresh = true,
  onCheck,
}: {
  enabled?: boolean;
  canRefresh?: boolean;
  onCheck?: (checkId: string) => boolean | void;
} = {}) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = enabled && localAccess ? (localContext?.workspace.id ?? null) : null;
  const identity = useRef({ workspaceId, context: localContext, requestLocal, generation: 0 });
  if (
    identity.current.workspaceId !== workspaceId ||
    identity.current.context !== localContext ||
    identity.current.requestLocal !== requestLocal
  )
    identity.current = {
      workspaceId,
      context: localContext,
      requestLocal,
      generation: identity.current.generation + 1,
    };
  const key = workspaceId ? `${workspaceId}:${identity.current.generation}` : null;
  const current = useRef(key),
    mounted = useRef(false),
    active = useRef<Pending | null>(null);
  current.current = key;
  const [capture, setCapture] = useState<{
    key: string;
    value: InventoryMonitorState;
    current: boolean;
  } | null>(null);
  const [lastHistory, setLastHistory] = useState<{
    key: string;
    value: InventoryMonitorState;
  } | null>(null);
  const [plan, setPlan] = useState<{ key: string; value: InventoryMonitorPreview } | null>(null);
  const [consent, setConsent] = useState<{
    id: string;
    localChecks: boolean;
    userSources: boolean;
    retention: boolean;
  } | null>(null);
  const [progress, setProgress] = useState<{ key: string; operation: Operation } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [pollFailures, setPollFailures] = useState(0);
  const [, changed] = useState(0);
  const state = capture?.key === key ? capture.value : null;
  const preview = plan?.key === key ? plan.value : null;
  const ack =
    preview && consent?.id === preview.id
      ? consent
      : { localChecks: false, userSources: false, retention: false };
  const busy = progress?.key === key ? progress.operation : null;
  const unresolved = attempts(requestLocal);
  const needsRecheck = workspaceId !== null && unresolved.has(workspaceId) && busy !== 'apply';
  const latest = useRef({ state, preview, ack, onCheck });
  latest.current = { state, preview, ack, onCheck };
  const observed = useRef({
    key,
    initialized: false,
    id: null as string | null,
    pending: null as string | null,
  });
  if (observed.current.key !== key)
    observed.current = { key, initialized: false, id: null, pending: null };
  const clearPlan = useCallback(() => {
    latest.current.preview = null;
    latest.current.ack = { localChecks: false, userSources: false, retention: false };
    setPlan(null);
    setConsent(null);
  }, []);
  const begin = useCallback(
    (operation: Operation) => {
      if (!mounted.current || !key || current.current !== key || active.current) return null;
      const controller = new AbortController();
      const record: Pending = { key, operation, controller, timer: undefined! };
      const accepts = () => mounted.current && current.current === key && active.current === record;
      record.timer = setTimeout(
        () => {
          if (!accepts()) return;
          controller.abort();
          active.current = null;
          setProgress(null);
          clearPlan();
          if (operation === 'load') setPollFailures((value) => value + 1);
          if (operation === 'load')
            setCapture((previous) =>
              previous?.key === key ? { ...previous, current: false } : previous,
            );
          setFailure({
            key,
            message:
              operation === 'apply'
                ? 'Watch change completion is unknown. Recheck the saved state before another action.'
                : operation === 'preview'
                  ? 'Preview timed out. Prepare a fresh preview.'
                  : 'Watch state could not be read before the deadline.',
          });
        },
        operation === 'apply' ? 35_000 : 25_000,
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
  const load = useCallback(
    async (explicit = false) => {
      const run = begin('load');
      if (!run || !key || !workspaceId) return;
      clearPlan();
      try {
        const value = await requestLocal(
          '/api/inventory-monitor',
          undefined,
          run.record.controller.signal,
        );
        if (!run.valid()) return;
        if (!validateInventoryMonitorState(value) || value.workspaceId !== workspaceId)
          throw new Error();
        setCapture({ key, value, current: true });
        if (value.history.status === 'ready') setLastHistory({ key, value });
        setPollFailures(0);
        const affected = attempts(requestLocal).get(workspaceId);
        if (
          explicit &&
          affected &&
          ['disabled', 'enabled', 'needs-review'].includes(value.status) &&
          value.runtimeSha256 === affected.runtimeSha256
        ) {
          attempts(requestLocal).delete(workspaceId);
          changed((value) => value + 1);
        }
      } catch {
        if (run.accepts()) {
          setCapture((previous) =>
            previous?.key === key ? { ...previous, current: false } : previous,
          );
          setPollFailures((value) => value + 1);
          setFailure({
            key,
            message: 'Saved watch state could not be verified. Refresh to retry.',
          });
        }
      } finally {
        run.finish();
      }
    },
    [begin, key, workspaceId, requestLocal, clearPlan],
  );
  useEffect(() => {
    mounted.current = true;
    setCapture(null);
    setLastHistory(null);
    clearPlan();
    setFailure(null);
    setPollFailures(0);
    if (key) void load();
    return () => {
      mounted.current = false;
      const pending = active.current;
      if (pending) {
        pending.controller.abort();
        clearTimeout(pending.timer);
      }
      active.current = null;
    };
  }, [key, load, clearPlan]);
  useEffect(() => {
    if (
      !key ||
      !state ||
      !['enabled', 'in-use'].includes(state.status) ||
      preview ||
      busy ||
      needsRecheck ||
      pollFailures >= 3
    )
      return;
    const timer = setTimeout(() => void load(), 10_000);
    return () => clearTimeout(timer);
  }, [key, state, preview, busy, needsRecheck, pollFailures, load]);
  useEffect(() => {
    if (!key || !state || !capture?.current) return;
    const seen = observed.current;
    if (!seen.initialized) {
      seen.initialized = true;
      seen.id = state.latestCheckId;
      return;
    }
    if (state.history.status !== 'ready') return;
    if (state.latestCheckId && state.latestCheckId !== seen.id) {
      seen.id = state.latestCheckId;
      seen.pending = state.latestCheckId;
    }
    if (!seen.pending || !canRefresh || busy || needsRecheck || !latest.current.onCheck) return;
    if (latest.current.onCheck(seen.pending) !== false) seen.pending = null;
  }, [key, state, capture?.current, canRefresh, busy, needsRecheck]);
  useEffect(() => {
    if (!key || !preview) return;
    const timer = setTimeout(
      () => {
        if (current.current !== key || latest.current.preview !== preview) return;
        clearPlan();
        setFailure({ key, message: 'Preview expired. Prepare a fresh preview.' });
      },
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [key, preview, clearPlan]);
  const refresh = () => {
    if (!mounted.current || !key || current.current !== key || active.current) return;
    clearPlan();
    setPollFailures(0);
    void load(true);
  };
  const prepare = async (action: Action) => {
    if (
      !workspaceId ||
      !state ||
      (action === 'pause'
        ? !state.revision ||
          !['enabled', 'needs-review', 'in-use', 'unavailable'].includes(state.status)
        : !state.runtimeSha256 ||
          !['disabled', 'enabled', 'needs-review'].includes(state.status)) ||
      latest.current.state !== state ||
      unresolved.has(workspaceId)
    )
      return;
    const run = begin('preview');
    if (!run || !key) return;
    clearPlan();
    try {
      const value = await requestLocal(
        '/api/inventory-monitor/preview',
        { action, expectedRevision: state.revision },
        run.record.controller.signal,
      );
      if (!run.valid()) return;
      if (
        !validateInventoryMonitorPreview(value) ||
        value.workspaceId !== workspaceId ||
        value.action !== action ||
        ((action === 'enable' || state.runtimeSha256 !== null) &&
          value.runtimeSha256 !== state.runtimeSha256) ||
        value.expectedRevision !== state.revision ||
        Date.now() >= Date.parse(value.expiresAt)
      )
        throw new Error();
      setPlan({ key, value });
    } catch {
      if (run.accepts())
        setFailure({
          key,
          message:
            'The watch preview could not be verified. Refresh the state before trying again.',
        });
    } finally {
      run.finish();
    }
  };
  const acknowledge = (field: 'localChecks' | 'userSources' | 'retention', value: boolean) => {
    if (
      !mounted.current ||
      !key ||
      current.current !== key ||
      !preview ||
      latest.current.preview !== preview ||
      active.current
    )
      return;
    const next = { id: preview.id, ...latest.current.ack, [field]: value };
    latest.current.ack = next;
    setConsent(next);
  };
  const apply = async () => {
    if (
      !workspaceId ||
      !preview ||
      latest.current.preview !== preview ||
      unresolved.has(workspaceId) ||
      Date.now() >= Date.parse(preview.expiresAt) ||
      (preview.action === 'enable' &&
        (!latest.current.ack.localChecks ||
          !latest.current.ack.userSources ||
          !latest.current.ack.retention))
    )
      return;
    if (unresolved.size >= 64) {
      setFailure({
        key: key!,
        message: 'Earlier watch changes need rechecking before another setting can be saved.',
      });
      return;
    }
    const run = begin('apply');
    if (!run || !key) return;
    unresolved.set(workspaceId, {
      runtimeSha256: preview.runtimeSha256,
      previewId: preview.id,
      action: preview.action,
    });
    changed((value) => value + 1);
    clearPlan();
    try {
      const value = await requestLocal(
        '/api/inventory-monitor/apply',
        {
          previewId: preview.id,
          confirm: true,
          acknowledgeLocalChecks: preview.action === 'enable',
          acknowledgeUserSources: preview.action === 'enable',
          acknowledgeRetention: preview.action === 'enable',
        },
        run.record.controller.signal,
      );
      if (!run.valid()) return;
      if (
        !validateInventoryMonitorReceipt(value) ||
        value.workspaceId !== workspaceId ||
        value.action !== preview.action ||
        value.runtimeSha256 !== preview.runtimeSha256 ||
        value.previewId !== preview.id ||
        value.enabled !== (preview.action === 'enable')
      )
        throw new Error();
      unresolved.delete(workspaceId);
      changed((value) => value + 1);
      run.finish();
      await load();
      return true;
    } catch {
      if (run.accepts())
        setFailure({
          key,
          message:
            'Watch change completion is unknown. Recheck the saved state before another action.',
        });
    } finally {
      run.finish();
    }
  };
  const invalidate = () => {
    if (!mounted.current || !key || current.current !== key) return;
    const pending = active.current;
    if (pending?.operation === 'preview') {
      pending.controller.abort();
      clearTimeout(pending.timer);
      active.current = null;
      setProgress(null);
    }
    clearPlan();
  };
  return {
    workspaceId,
    state,
    historyState:
      state?.history.status === 'ready'
        ? state
        : lastHistory?.key === key
          ? lastHistory.value
          : null,
    historyHistorical: !capture?.current || state?.history.status !== 'ready',
    freshness: !state ? 'unavailable' : capture?.current ? 'current' : 'historical',
    preview,
    ack,
    busy,
    needsRecheck,
    error: failure?.key === key ? failure.message : null,
    pollStopped: pollFailures >= 3,
    refresh,
    prepare,
    acknowledge,
    apply,
    invalidate,
  };
}
