'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import { validateSkillQuarantine, type SkillQuarantineState } from '@/lib/skill-quarantine';
import { confirmQuarantineRecheck } from '@/lib/quarantine-recheck';
export function useSkillQuarantine() {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const [state, setState] = useState<SkillQuarantineState | null>(null);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const workspaceId = localContext?.workspace.id;
  const refresh = useCallback(
    async (explicit = true) => {
      if (!localAccess || !workspaceId) return;
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      const timer = setTimeout(() => controller.abort(), 35_000);
      setLoading(true);
      setError(null);
      try {
        const value = await requestLocal('/api/quarantine', undefined, controller.signal);
        if (!validateSkillQuarantine(value) || value.workspaceId !== workspaceId)
          throw new Error('Quarantine evidence does not match this workspace.');
        if (active.current === controller) {
          setState(value);
          if (explicit) confirmQuarantineRecheck(requestLocal, value);
        }
      } catch (e) {
        if (active.current === controller)
          setError(
            e instanceof Error && e.name !== 'AbortError'
              ? e.message
              : 'The recheck timed out. Earlier evidence is historical.',
          );
      } finally {
        clearTimeout(timer);
        if (active.current === controller) {
          active.current = null;
          setLoading(false);
        }
      }
    },
    [localAccess, workspaceId, requestLocal],
  );
  useEffect(() => {
    void refresh(false);
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [refresh]);
  return {
    localAccess,
    workspaceId,
    state: state?.workspaceId === workspaceId ? state : null,
    loading,
    error,
    refresh,
  };
}
