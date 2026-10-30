'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
export type CodexSkillControlOperation = 'load' | 'preview' | 'apply' | 'recheck';
/** One local request at a time; stale or aborted replies never publish. */
export function useCodexSkillControlOperation(
  key: string | null,
  onTimeout: (operation: CodexSkillControlOperation) => void,
) {
  const mounted = useRef(false),
    current = useRef(key),
    timeout = useRef(onTimeout);
  current.current = key;
  timeout.current = onTimeout;
  const active = useRef<{
    key: string;
    operation: CodexSkillControlOperation;
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [progress, setProgress] = useState<{
    key: string;
    operation: CodexSkillControlOperation;
  } | null>(null);
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
  const begin = useCallback(
    (operation: CodexSkillControlOperation) => {
      if (!mounted.current || !key || current.current !== key || active.current) return null;
      const pending = {
        key,
        operation,
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
          pending.controller.abort();
          active.current = null;
          setProgress(null);
          timeout.current(operation);
        },
        operation === 'apply' ? 60000 : 30000,
      );
      active.current = pending;
      setProgress({ key, operation });
      return {
        pending,
        accepts,
        finish: () => {
          clearTimeout(pending.timer);
          if (active.current === pending) {
            active.current = null;
            if (mounted.current) setProgress(null);
          }
        },
      };
    },
    [key],
  );
  return {
    begin,
    cancel,
    isBusy: () => active.current !== null,
    busy: key && progress?.key === key ? progress.operation : null,
  };
}
