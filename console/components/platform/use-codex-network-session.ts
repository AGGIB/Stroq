'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import { networkMessage } from '@/lib/codex-network-client';
export type NetworkOperation =
  | 'load'
  | 'capture'
  | 'preview'
  | 'apply'
  | 'recheck'
  | 'check-load'
  | 'check-preview'
  | 'check-start'
  | 'check-cancel'
  | 'check-poll';
export function useCodexNetworkSession(open: boolean) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
  const identity = useRef({ open, localContext, requestLocal, generation: 0 });
  if (
    identity.current.open !== open ||
    identity.current.localContext !== localContext ||
    identity.current.requestLocal !== requestLocal
  )
    identity.current = {
      open,
      localContext,
      requestLocal,
      generation: identity.current.generation + 1,
    };
  const key =
    open && workspaceId && /^workspace-[a-f0-9]{24}$/.test(workspaceId)
      ? `${workspaceId}:${identity.current.generation}`
      : null;
  const current = useRef(key),
    mounted = useRef(false);
  current.current = key;
  const active = useRef<{
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [progress, setProgress] = useState<{ key: string; operation: NetworkOperation } | null>(
      null,
    ),
    [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const cancel = useCallback(() => {
    const pending = active.current;
    active.current = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.controller.abort();
    }
    if (mounted.current) setProgress(null);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel();
    };
  }, [key, cancel]);
  const fail = useCallback(
    (message: string, error?: unknown) => {
      if (key && current.current === key && mounted.current)
        setFailure({ key, message: networkMessage(error, message) });
    },
    [key],
  );
  const begin = useCallback(
    (operation: NetworkOperation, onTimeout?: () => void) => {
      if (!mounted.current || !key || current.current !== key || active.current) return null;
      const pending = {
        controller: new AbortController(),
        timer: undefined! as ReturnType<typeof setTimeout>,
      };
      const accepts = () =>
        mounted.current &&
        current.current === key &&
        active.current === pending &&
        !pending.controller.signal.aborted;
      pending.timer = setTimeout(
        () => {
          if (!accepts()) return;
          active.current = null;
          pending.controller.abort();
          setProgress(null);
          onTimeout?.();
          fail(
            ['apply', 'check-start', 'check-cancel'].includes(operation)
              ? 'Completion is unknown. Recheck this exact operation.'
              : 'The local read timed out. Reload to retry.',
          );
        },
        operation === 'check-poll' ? 12000 : operation === 'apply' ? 60000 : 30000,
      );
      active.current = pending;
      setProgress({ key, operation });
      setFailure(null);
      return {
        signal: pending.controller.signal,
        accepts,
        finish() {
          clearTimeout(pending.timer);
          if (active.current === pending) {
            active.current = null;
            if (mounted.current) setProgress(null);
          }
        },
      };
    },
    [key, fail],
  );
  return {
    key,
    workspaceId,
    requestLocal,
    begin,
    cancel,
    fail,
    busy: key && progress?.key === key ? progress.operation : null,
    error: key && failure?.key === key ? failure.message : null,
    isCurrent: () => !!key && current.current === key && mounted.current,
    isBusy: () => active.current !== null,
  };
}
export type CodexNetworkSession = ReturnType<typeof useCodexNetworkSession>;
