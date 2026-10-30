'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import {
  validateCodexSkillSourcesReport,
  type CodexSkillSourcesReport,
} from '@/lib/codex-skill-sources';

interface Pending {
  key: string;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}
/** Manual, non-persisting inspection. Mounting or navigating never captures sources. */
export function useCodexSkillSources() {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
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
  const key =
    workspaceId && /^workspace-[a-f0-9]{24}$/.test(workspaceId)
      ? `${workspaceId}:${identity.current.generation}`
      : null;
  const current = useRef(key),
    mounted = useRef(false),
    active = useRef<Pending | null>(null);
  current.current = key;
  const [capture, setCapture] = useState<{
    key: string;
    report: CodexSkillSourcesReport;
    historical: boolean;
  } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const cancel = useCallback(() => {
    const pending = active.current;
    active.current = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.controller.abort();
    if (mounted.current) {
      setProgress(null);
      setCapture((previous) =>
        previous?.key === pending.key ? { ...previous, historical: true } : previous,
      );
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel();
    };
  }, [key, cancel]);
  const inspect = useCallback(async () => {
    if (!mounted.current || !key || !workspaceId || current.current !== key || active.current)
      return;
    const pending: Pending = { key, controller: new AbortController(), timer: undefined! };
    const accepts = () =>
      mounted.current &&
      current.current === key &&
      active.current === pending &&
      !pending.controller.signal.aborted;
    pending.timer = setTimeout(() => {
      if (!accepts()) return;
      active.current = null;
      pending.controller.abort();
      setProgress(null);
      setFailure({ key, message: 'Source inspection timed out. Retry to inspect again.' });
    }, 30_000);
    active.current = pending;
    setProgress(key);
    setFailure(null);
    setCapture((previous) =>
      previous?.key === key ? { ...previous, historical: true } : previous,
    );
    try {
      const value = await requestLocal(
        '/api/inventory/codex-sources',
        {},
        pending.controller.signal,
      );
      if (!accepts()) return;
      if (!validateCodexSkillSourcesReport(value) || value.workspaceId !== workspaceId)
        throw new Error('source-report-mismatch');
      setCapture({ key, report: value, historical: false });
    } catch {
      if (accepts())
        setFailure({ key, message: 'Source inspection failed. Retry to inspect again.' });
    } finally {
      clearTimeout(pending.timer);
      if (active.current === pending) {
        active.current = null;
        setProgress(null);
      }
    }
  }, [key, workspaceId, requestLocal]);
  const report = key && capture?.key === key ? capture.report : null;
  const markHistorical = useCallback(() => {
    if (!mounted.current || !key || current.current !== key) return;
    setCapture((previous) =>
      previous?.key === key ? { ...previous, historical: true } : previous,
    );
  }, [key]);
  return {
    available: key !== null,
    report,
    historical: report !== null && capture?.historical === true,
    busy: key !== null && progress === key && active.current?.key === key,
    error: failure?.key === key ? failure.message : null,
    inspect,
    cancel,
    markHistorical,
  };
}
