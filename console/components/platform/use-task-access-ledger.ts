'use client';
import { useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import { validateTaskAccessState, type TaskAccessState } from '@/lib/task-access';
import { taskAccessStateMatches } from '@/lib/task-access-binding';
import type { TaskLockRow } from '@/lib/task-locks';
export function useTaskAccessLedger(task: TaskLockRow | null) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
  const selected =
    workspaceId && task ? JSON.stringify([workspaceId, task.id, task.permitSha256]) : null;
  const identity = useRef({ selected, requestLocal, context: localContext, generation: 0 });
  if (
    identity.current.selected !== selected ||
    identity.current.requestLocal !== requestLocal ||
    identity.current.context !== localContext
  )
    identity.current = {
      selected,
      requestLocal,
      context: localContext,
      generation: identity.current.generation + 1,
    };
  const key = selected ? `${selected}:${identity.current.generation}` : null;
  const current = useRef(key);
  const mounted = useRef(false);
  current.current = key;
  const active = useRef<{
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [capture, setCapture] = useState<{ key: string; value: TaskAccessState } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    setCapture(null);
    setFailure(null);
    setPending(null);
    return () => {
      mounted.current = false;
      if (active.current) {
        active.current.controller.abort();
        clearTimeout(active.current.timer);
      }
      active.current = null;
    };
  }, [key]);
  const load = async () => {
    if (
      !mounted.current ||
      !key ||
      !workspaceId ||
      !task ||
      current.current !== key ||
      active.current
    )
      return;
    const controller = new AbortController();
    const record = { controller, timer: undefined! as ReturnType<typeof setTimeout> };
    const accepts = () => current.current === key && active.current === record;
    record.timer = setTimeout(() => {
      if (!accepts()) return;
      controller.abort();
      active.current = null;
      setPending(null);
      setFailure({ key, message: 'Existing permissions timed out. No empty state was inferred.' });
    }, 25000);
    active.current = record;
    setPending(key);
    setCapture(null);
    setFailure(null);
    try {
      const value = await requestLocal(
        `/api/task-locks/access/${task.id}/${task.permitSha256}`,
        undefined,
        controller.signal,
      );
      if (!accepts() || controller.signal.aborted) return;
      if (
        !validateTaskAccessState(value) ||
        !taskAccessStateMatches(value, workspaceId, task.id, task.permitSha256)
      )
        throw new Error();
      setCapture({ key, value });
    } catch {
      if (accepts())
        setFailure({
          key,
          message: 'Existing one-use permissions are unavailable. No empty state was inferred.',
        });
    } finally {
      clearTimeout(record.timer);
      if (active.current === record) {
        active.current = null;
        setPending(null);
      }
    }
  };
  return {
    state: key && capture?.key === key ? capture.value : null,
    loading: key !== null && pending === key,
    error: key && failure?.key === key ? failure.message : null,
    available: key !== null,
    load,
  };
}
