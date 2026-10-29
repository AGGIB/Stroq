'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import {
  parseSeenKeys,
  postureChanges,
  postureKey,
  validatePostureAudit,
  type PostureAudit,
  type PostureChanges,
} from '@/lib/posture';

const DEADLINE_MS = 10_000;
const SEEN_KEY = 'stroq-posture-seen';

export type PostureState = 'loading' | 'ready' | 'error';

function readSeen(): string[] | null {
  try {
    return parseSeenKeys(JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? 'null'));
  } catch {
    return null;
  }
}

function writeSeen(audit: PostureAudit): void {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(audit.findings.map(postureKey)));
  } catch {
    /* Remembering is a convenience; the page works without it. */
  }
}

/**
 * Reads the settings check once when the page opens, and again when the person asks. Nothing polls.
 * With `track`, it also compares with the last check this browser recorded and records this one.
 */
export function usePosture({ track = false }: { track?: boolean } = {}) {
  const { localAccess, requestLocal } = usePlatform();
  const [audit, setAudit] = useState<PostureAudit | null>(null);
  const [changes, setChanges] = useState<PostureChanges | null>(null);
  const [state, setState] = useState<PostureState>('loading');
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);

  const load = useCallback(async () => {
    const generation = ++run.current;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), DEADLINE_MS);
    setState('loading');
    setError(null);
    try {
      const value = await requestLocal('/api/posture', undefined, controller.signal);
      if (generation !== run.current) return;
      if (!validatePostureAudit(value))
        throw new Error('Unsupported settings check reply. Nothing was accepted.');
      if (track) {
        setChanges(postureChanges(readSeen(), value.findings));
        writeSeen(value);
      }
      setAudit(value);
      setState('ready');
    } catch (e) {
      if (generation !== run.current) return;
      setError(
        e instanceof Error && e.name !== 'AbortError'
          ? e.message
          : 'The settings check did not answer in time.',
      );
      setState('error');
    } finally {
      clearTimeout(deadline);
    }
  }, [requestLocal, track]);

  useEffect(() => {
    if (!localAccess) return;
    void load();
    return () => {
      run.current += 1;
    };
  }, [localAccess, load]);

  return { localAccess, audit, changes, state, error, reload: load };
}
