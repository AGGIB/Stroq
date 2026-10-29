'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import { validateMcpContainment, type McpContainmentState } from '@/lib/mcp-containment';
import {
  mcpContainmentReadAllowed,
  type McpContainmentSelection,
} from '@/lib/mcp-containment-navigation';

export function useMcpContainment(selection: McpContainmentSelection) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = localContext?.workspace.id ?? null;
  const allowed = localAccess && mcpContainmentReadAllowed(selection, workspaceId);
  const [snapshot, setSnapshot] = useState<McpContainmentState | null>(null);
  const [progress, setProgress] = useState<{
    workspaceId: string;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const active = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (!allowed || !workspaceId) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const timer = setTimeout(() => controller.abort(), 35_000);
    setProgress({ workspaceId, loading: true, error: null });
    try {
      const value = await requestLocal('/api/mcp-containment', undefined, controller.signal);
      if (!validateMcpContainment(value) || value.workspaceId !== workspaceId)
        throw new Error('Registration evidence does not match this workspace.');
      if (active.current === controller) {
        setSnapshot(value);
        setProgress({ workspaceId, loading: false, error: null });
      }
    } catch (failure) {
      if (active.current === controller)
        setProgress({
          workspaceId,
          loading: false,
          error:
            failure instanceof Error && failure.name !== 'AbortError'
              ? failure.message
              : 'Registration recheck timed out. Earlier observations remain historical.',
        });
    } finally {
      clearTimeout(timer);
      if (active.current === controller) active.current = null;
    }
  }, [allowed, workspaceId, requestLocal]);
  useEffect(() => {
    if (!allowed) {
      setSnapshot(null);
      setProgress(null);
    } else void refresh();
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [refresh, allowed]);
  const current = allowed && progress?.workspaceId === workspaceId ? progress : null;
  return {
    localAccess,
    workspaceId,
    allowed,
    state: allowed && snapshot?.workspaceId === workspaceId ? snapshot : null,
    loading: current?.loading ?? false,
    error: current?.error ?? null,
    refresh,
  };
}
