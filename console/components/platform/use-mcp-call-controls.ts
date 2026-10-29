'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import {
  validateMcpCallControlOverview,
  type McpCallControlOverview,
} from '@/lib/mcp-call-control-overview';
import { classifyCallControlPending } from '@/lib/mcp-call-control-binding';
import type { McpCallControlLocation } from '@/lib/mcp-call-control-navigation';
export function useMcpCallControls(location: McpCallControlLocation) {
  const { localAccess, localContext, requestLocal } = usePlatform(),
    workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
  const allowed = Boolean(workspaceId && !location.invalid),
    identity = useRef({ localContext, requestLocal, generation: 0 });
  if (
    identity.current.localContext !== localContext ||
    identity.current.requestLocal !== requestLocal
  )
    identity.current = { localContext, requestLocal, generation: identity.current.generation + 1 };
  const key = allowed
      ? `${workspaceId}:${identity.current.generation}:${location.controlId}:${location.contextId}`
      : null,
    current = useRef(key);
  current.current = key;
  const active = useRef<{
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [result, setResult] = useState<{
    key: string;
    state: McpCallControlOverview | null;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const refresh = useCallback(async () => {
    if (!key || active.current) return;
    const r = {
        controller: new AbortController(),
        timer: undefined! as ReturnType<typeof setTimeout>,
      },
      accepts = () => current.current === key && active.current === r;
    r.timer = setTimeout(() => {
      if (!accepts()) return;
      r.controller.abort();
      active.current = null;
      setResult({
        key,
        state: null,
        loading: false,
        error: 'Call-control read timed out. Retained decisions remain historical.',
      });
    }, 30_000);
    active.current = r;
    setResult({ key, state: null, loading: true, error: null });
    try {
      const value = await requestLocal('/api/mcp-call-controls', undefined, r.controller.signal);
      if (!accepts() || r.controller.signal.aborted) return;
      if (!validateMcpCallControlOverview(value) || value.workspaceId !== workspaceId)
        throw Error();
      setResult({ key, state: value, loading: false, error: null });
    } catch {
      if (accepts())
        setResult({
          key,
          state: null,
          loading: false,
          error: 'Call-control authority could not be verified.',
        });
    } finally {
      clearTimeout(r.timer);
      if (active.current === r) active.current = null;
    }
  }, [key, requestLocal, workspaceId]);
  useEffect(() => {
    setResult(null);
    if (key) void refresh();
    return () => {
      if (active.current) {
        active.current.controller.abort();
        clearTimeout(active.current.timer);
      }
      active.current = null;
    };
  }, [key, refresh]);
  const value = key && result?.key === key ? result : null;
  return {
    localAccess,
    workspaceId,
    contextId: value?.state?.contextId ?? null,
    state: value?.state ?? null,
    loading: value?.loading ?? false,
    error: value?.error ?? null,
    refresh,
    ...classifyCallControlPending(requestLocal, workspaceId, value?.state?.contextId ?? null),
  };
}
