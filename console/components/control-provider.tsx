'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePlatform } from './platform-provider';
import {
  validateControl,
  validateRun,
  controlRunOwned,
  type ControlState,
  type ControlRun,
  type RunInput,
} from '@/lib/control';

interface ControlContext {
  ready: boolean;
  loading: boolean;
  error: string | null;
  control: ControlState | null;
  runs: ControlRun[];
  busy: boolean;
  needsRecheck: boolean;
  refresh: (explicit?: boolean) => Promise<void>;
  start: (input: RunInput) => Promise<ControlRun | null>;
  cancel: (id: string) => Promise<ControlRun | null>;
}
const Context = createContext<ControlContext | null>(null);
const noRuns: ControlRun[] = [];
interface PendingAction {
  key: number;
  controller: AbortController;
}
export function ControlProvider({ children }: { children: ReactNode }) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const identity = useRef({ localAccess, localContext, requestLocal, generation: 0 });
  if (
    identity.current.localAccess !== localAccess ||
    identity.current.localContext !== localContext ||
    identity.current.requestLocal !== requestLocal
  )
    identity.current = {
      localAccess,
      localContext,
      requestLocal,
      generation: identity.current.generation + 1,
    };
  const key = identity.current.generation;
  const [capture, setCapture] = useState<{ key: number; control: ControlState } | null>(null);
  const [loadingKey, setLoadingKey] = useState<number | null>(null);
  const [startingKey, setStartingKey] = useState<number | null>(null);
  const [failure, setFailure] = useState<{ key: number; message: string } | null>(null);
  const [unknownKey, setUnknownKey] = useState<number | null>(null);
  const [pollFailures, setPollFailures] = useState(0);
  const readGeneration = useRef(0),
    pending = useRef<PendingAction | null>(null),
    uncertain = useRef<number | null>(null),
    mounted = useRef(true);
  const control = capture?.key === key ? capture.control : null;
  const loading = loadingKey === key,
    starting = startingKey === key;
  const needsRecheck = unknownKey === key;
  const error = failure?.key === key ? failure.message : null;
  const current = useRef({ key, control });
  current.current = { key, control };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readGeneration.current++;
      pending.current?.controller.abort();
      pending.current = null;
    };
  }, []);
  useEffect(() => {
    pending.current?.controller.abort();
    pending.current = null;
    uncertain.current = null;
    setUnknownKey(null);
    setStartingKey(null);
    setPollFailures(0);
  }, [key]);
  const refresh = useCallback(
    async (explicit = true) => {
      if (!mounted.current || !localAccess || !localContext || identity.current.generation !== key)
        return;
      const revision = ++readGeneration.current;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const accepts = () =>
        mounted.current &&
        identity.current.generation === key &&
        revision === readGeneration.current;
      setLoadingKey(key);
      try {
        const result = await requestLocal('/api/control', undefined, controller.signal);
        if (!accepts()) return;
        if (
          !validateControl(result) ||
          (result.workspaceId && result.workspaceId !== localContext.workspace.id)
        )
          throw new Error('invalid-report');
        setCapture({ key, control: result });
        setFailure(null);
        setPollFailures(0);
        if (explicit && result.history.status === 'ready') {
          uncertain.current = null;
          setUnknownKey(null);
        }
      } catch {
        if (accepts()) {
          setFailure({
            key,
            message: 'Local checks could not be read. Refresh to check recorded status.',
          });
          setPollFailures((n) => n + 1);
        }
      } finally {
        clearTimeout(timer);
        if (accepts()) setLoadingKey(null);
      }
    },
    [localAccess, localContext, requestLocal, key],
  );
  useEffect(() => {
    void refresh(false);
  }, [refresh]);
  const runs = control?.runs ?? noRuns;
  const observedRunning = runs.some((r) => r.status === 'running');
  const running = runs.some((r) => controlRunOwned(r, control));
  useEffect(() => {
    if (!observedRunning || starting || loading || pollFailures >= 3 || needsRecheck) return;
    const timer = setTimeout(() => void refresh(false), 1500 * (pollFailures + 1));
    return () => clearTimeout(timer);
  }, [observedRunning, starting, loading, pollFailures, needsRecheck, refresh]);
  const action = useCallback(
    async (input: RunInput | { id: string }, cancel = false): Promise<ControlRun | null> => {
      const bound = current.current.control;
      if (
        !mounted.current ||
        !localAccess ||
        !localContext ||
        !bound ||
        identity.current.generation !== key ||
        pending.current ||
        uncertain.current === key
      )
        return null;
      const selected = cancel
        ? bound.runs.find((r) => r.id === (input as { id: string }).id)
        : null;
      if (
        cancel &&
        (selected?.kind !== 'protection-check' ||
          selected.status !== 'running' ||
          bound.activeProtectionCheckId !== selected.id)
      )
        return null;
      if (
        !cancel &&
        (!bound.engine.available ||
          bound.history.status === 'error' ||
          bound.runs.some((r) => controlRunOwned(r, bound)))
      )
        return null;
      if (
        (cancel || (input as RunInput).kind === 'protection-check') &&
        bound.workspaceId !== localContext.workspace.id
      )
        return null;
      const record = { key, controller: new AbortController() };
      pending.current = record;
      ++readGeneration.current;
      setLoadingKey(null);
      setStartingKey(key);
      setFailure(null);
      const accepts = () =>
        mounted.current && identity.current.generation === key && pending.current === record;
      const timer = setTimeout(() => record.controller.abort(), cancel ? 30_000 : 10_000);
      try {
        const result = await requestLocal(
          cancel ? '/api/runs/cancel' : '/api/runs',
          input,
          record.controller.signal,
        );
        if (!accepts()) return null;
        if (
          !validateRun(result) ||
          (cancel
            ? result.kind !== 'protection-check' ||
              result.id !== selected!.id ||
              result.status === 'running'
            : result.kind !== (input as RunInput).kind)
        )
          throw new Error('invalid-report');
        if (
          result.kind === 'protection-check' &&
          result.progress?.steps.some(
            (step) =>
              step.result &&
              'workspaceId' in step.result &&
              step.result.workspaceId !== localContext.workspace.id,
          )
        )
          throw new Error('invalid-report');
        ++readGeneration.current;
        setLoadingKey(null);
        setCapture((previous) =>
          previous?.key === key
            ? {
                key,
                control: {
                  ...previous.control,
                  ...(Object.hasOwn(previous.control, 'activeRunId')
                    ? {
                        activeRunId: result.status === 'running' ? result.id : null,
                        activeProtectionCheckId:
                          result.kind === 'protection-check' && result.status === 'running'
                            ? result.id
                            : null,
                      }
                    : {}),
                  ...(result.kind === 'protection-check'
                    ? { activeProtectionCheckId: result.status === 'running' ? result.id : null }
                    : {}),
                  runs: [result, ...previous.control.runs.filter((r) => r.id !== result.id)].slice(
                    0,
                    32,
                  ),
                },
              }
            : previous,
        );
        setPollFailures(0);
        return result;
      } catch {
        if (accepts()) {
          ++readGeneration.current;
          setLoadingKey(null);
          uncertain.current = key;
          setUnknownKey(key);
          setFailure({
            key,
            message: 'Completion is unknown. Refresh recorded checks before another action.',
          });
        }
        return null;
      } finally {
        clearTimeout(timer);
        if (pending.current === record) {
          pending.current = null;
          if (mounted.current && identity.current.generation === key) setStartingKey(null);
        }
      }
    },
    [localAccess, localContext, requestLocal, key],
  );
  const start = useCallback((input: RunInput) => action(input), [action]);
  const cancel = useCallback((id: string) => action({ id }, true), [action]);
  return (
    <Context.Provider
      value={{
        ready: localAccess,
        loading,
        error,
        control,
        runs,
        busy: running || starting || needsRecheck || control?.history.status === 'error',
        needsRecheck,
        refresh,
        start,
        cancel,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useControl() {
  const context = useContext(Context);
  if (!context) throw new Error('ControlProvider is required');
  return context;
}
