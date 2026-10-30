'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import { validatePolicyCases, type PolicyCasesState } from '@/lib/policy-cases';

/** Reads and evaluates fixed local class checks; never saves, removes or runs an agent. */
export function usePolicyCases(enabled = true, requestKey = '') {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
  const key = enabled && workspaceId ? `${workspaceId}:${requestKey}` : null;
  const currentKey = useRef(key);
  currentKey.current = key;
  const active = useRef<{
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [snapshot, setSnapshot] = useState<{ key: string; value: PolicyCasesState } | null>(null);
  const [progress, setProgress] = useState<{
    key: string;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(async (): Promise<PolicyCasesState | null> => {
    if (!key || !workspaceId) return null;
    active.current?.controller.abort();
    if (active.current) clearTimeout(active.current.timer);
    const controller = new AbortController();
    const accepts = () => currentKey.current === key && active.current?.controller === controller;
    const timer = setTimeout(() => {
      controller.abort();
      if (!accepts()) return;
      active.current = null;
      setProgress({
        key,
        loading: false,
        error: 'Saved checks could not be refreshed. No current result is available.',
      });
    }, 25_000);
    active.current = { controller, timer };
    setGeneration((value) => value + 1);
    setSnapshot(null);
    setProgress({ key, loading: true, error: null });
    try {
      const value = await requestLocal('/api/policy/cases', undefined, controller.signal);
      if (
        controller.signal.aborted ||
        !validatePolicyCases(value) ||
        value.workspaceId !== workspaceId
      )
        throw new Error();
      if (!accepts()) return null;
      setSnapshot({ key, value });
      setProgress({ key, loading: false, error: null });
      return value;
    } catch {
      if (accepts())
        setProgress({
          key,
          loading: false,
          error: 'Saved checks could not be refreshed. No current result is available.',
        });
      return null;
    } finally {
      clearTimeout(timer);
      if (accepts()) active.current = null;
    }
  }, [key, workspaceId, requestLocal]);
  useEffect(() => {
    if (key) void refresh();
    return () => {
      active.current?.controller.abort();
      if (active.current) clearTimeout(active.current.timer);
      active.current = null;
    };
  }, [key, refresh]);
  return {
    localAccess,
    workspaceId,
    generation,
    refresh,
    state: key && snapshot?.key === key ? snapshot.value : null,
    loading: key && progress?.key === key ? progress.loading : false,
    error: key && progress?.key === key ? progress.error : null,
  };
}
