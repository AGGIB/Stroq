'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import { validateHookCheckState, type HookCheckState } from '@/lib/hook-checks';

/** Read-only history. Mounting and refreshing never prepare or start a test. */
export function useHookCheckHistory({
  enabled = true,
  generation = 0,
}: { enabled?: boolean; generation?: number } = {}) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
  const selected =
    enabled &&
    workspaceId &&
    /^workspace-[a-f0-9]{24}$/.test(workspaceId) &&
    Number.isSafeInteger(generation) &&
    generation >= 0
      ? `${workspaceId}:${generation}`
      : null;
  const connection = useRef({ selected, context: localContext, requestLocal, version: 0 });
  if (
    connection.current.selected !== selected ||
    connection.current.context !== localContext ||
    connection.current.requestLocal !== requestLocal
  ) {
    connection.current = {
      selected,
      context: localContext,
      requestLocal,
      version: connection.current.version + 1,
    };
  }
  const key = selected ? `${selected}:${connection.current.version}` : null;
  const current = useRef(key);
  current.current = key;
  const mounted = useRef(false);
  const active = useRef<{
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [capture, setCapture] = useState<{ key: string; state: HookCheckState } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [pollFailure, setPollFailure] = useState<{ key: string; count: number } | null>(null);
  const state = key && capture?.key === key ? capture.state : null;
  const busy = key !== null && progress === key;
  const failures = key && pollFailure?.key === key ? pollFailure.count : 0;
  const load = useCallback(
    async (poll = false) => {
      if (!mounted.current || !key || !workspaceId || current.current !== key || active.current)
        return;
      const controller = new AbortController();
      const record = { controller, timer: undefined! as ReturnType<typeof setTimeout> };
      const accepts = () => mounted.current && current.current === key && active.current === record;
      const failed = () => {
        if (poll)
          setPollFailure((before) => ({ key, count: before?.key === key ? before.count + 1 : 1 }));
        else setCapture(null);
        setFailure({
          key,
          message: 'Hook-check history could not be read. Recorded results are historical.',
        });
      };
      record.timer = setTimeout(() => {
        if (!accepts()) return;
        controller.abort();
        active.current = null;
        setProgress(null);
        failed();
      }, 25_000);
      active.current = record;
      setProgress(key);
      if (!poll) setFailure(null);
      try {
        const value = await requestLocal('/api/hook-checks', undefined, controller.signal);
        if (!accepts() || controller.signal.aborted) return;
        if (!validateHookCheckState(value) || value.workspaceId !== workspaceId) throw new Error();
        setCapture({ key, state: value });
        setPollFailure(null);
        setFailure(
          value.history.status === 'error'
            ? { key, message: 'Retained hook-check history is unavailable.' }
            : null,
        );
      } catch {
        if (accepts()) failed();
      } finally {
        clearTimeout(record.timer);
        if (active.current === record) {
          active.current = null;
          setProgress(null);
        }
      }
    },
    [key, workspaceId, requestLocal],
  );
  useEffect(() => {
    mounted.current = true;
    setCapture(null);
    setFailure(null);
    setPollFailure(null);
    if (key) void load();
    return () => {
      mounted.current = false;
      if (active.current) {
        active.current.controller.abort();
        clearTimeout(active.current.timer);
      }
      active.current = null;
    };
  }, [key, load]);
  useEffect(() => {
    if (!key || busy || failures >= 3 || !state?.jobs.some((job) => job.status === 'running'))
      return;
    const timer = setTimeout(() => void load(true), 1000 * (failures + 1));
    return () => clearTimeout(timer);
  }, [key, state, busy, failures, load]);
  const refresh = () => {
    if (!mounted.current || !key || current.current !== key) return;
    if (active.current) {
      active.current.controller.abort();
      clearTimeout(active.current.timer);
      active.current = null;
    }
    setCapture(null);
    setPollFailure(null);
    void load();
  };
  return {
    workspaceId,
    state,
    busy,
    error: key && failure?.key === key ? failure.message : null,
    refresh,
  };
}
