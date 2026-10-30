'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import { validateCredentialFilters, type CredentialFiltersState } from '@/lib/credential-filters';

/** One parent-owned read for the fixed targets. Opening or rechecking never applies a recipe. */
export function useCredentialFilters(enabled = true, requestKey?: string) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = localAccess && enabled ? (localContext?.workspace.id ?? null) : null;
  const [snapshot, setSnapshot] = useState<{
    requestKey?: string;
    value: CredentialFiltersState;
  } | null>(null);
  const [progress, setProgress] = useState<{
    workspaceId: string;
    requestKey?: string;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const [generation, setGeneration] = useState(0);
  const active = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (!workspaceId) return false;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const timer = setTimeout(() => controller.abort(), 35_000);
    setGeneration((value) => value + 1);
    setProgress({ workspaceId, requestKey, loading: true, error: null });
    setSnapshot(null);
    try {
      const value = await requestLocal('/api/credential-filters', undefined, controller.signal);
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!validateCredentialFilters(value) || value.workspaceId !== workspaceId)
        throw new Error('Filter evidence does not match this workspace.');
      if (active.current === controller && !controller.signal.aborted) {
        setSnapshot({ requestKey, value });
        setProgress({ workspaceId, requestKey, loading: false, error: null });
        return true;
      }
    } catch {
      if (active.current === controller)
        setProgress({
          workspaceId,
          requestKey,
          loading: false,
          error:
            'Credential file filters could not be rechecked. No current configuration claim is available.',
        });
      return false;
    } finally {
      clearTimeout(timer);
      if (active.current === controller) active.current = null;
    }
  }, [workspaceId, requestLocal, requestKey]);
  useEffect(() => {
    if (workspaceId) void refresh();
    else {
      setSnapshot(null);
      setProgress(null);
    }
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [workspaceId, refresh]);
  const current =
    progress?.workspaceId === workspaceId && progress?.requestKey === requestKey ? progress : null;
  return {
    workspaceId,
    state:
      workspaceId &&
      snapshot?.value.workspaceId === workspaceId &&
      snapshot.requestKey === requestKey
        ? snapshot.value
        : null,
    generation,
    loading: current?.loading ?? false,
    error: current?.error ?? null,
    refresh,
  };
}
