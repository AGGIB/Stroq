'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import { shouldStart, validateCardState, type CardState } from '@/lib/card';

const POLL_MS = 1500;
const DEADLINE_MS = 10_000;

/**
 * The card for the Check screen. It reads the engine's state when the screen opens, starts a run when
 * there is no card yet or the one there is old, and follows a run that is going by asking again every
 * second and a half until it ends. Nothing else polls, and nothing runs while the screen is closed.
 */
export function useCard() {
  const { localAccess, requestLocal } = usePlatform();
  const [state, setState] = useState<CardState | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const alive = useRef(true);
  const opened = useRef(false);

  const accept = useCallback((value: unknown): CardState | null => {
    if (!validateCardState(value)) {
      setProblem(
        'The engine returned a card this console does not understand. None of it was shown.',
      );
      return null;
    }
    setProblem(null);
    setState(value);
    return value;
  }, []);

  const call = useCallback(
    async (path: string, body?: unknown) => {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), DEADLINE_MS);
      try {
        return await requestLocal(path, body, controller.signal);
      } finally {
        clearTimeout(deadline);
      }
    },
    [requestLocal],
  );

  const load = useCallback(async () => {
    try {
      const value = accept(await call('/api/card'));
      if (alive.current) return value;
    } catch (error) {
      if (alive.current)
        setProblem(error instanceof Error ? error.message : 'The card could not be read.');
    }
    return null;
  }, [accept, call]);

  const check = useCallback(async () => {
    try {
      accept(await call('/api/card/start', {}));
    } catch (error) {
      if (alive.current)
        setProblem(error instanceof Error ? error.message : 'The check could not be started.');
    }
  }, [accept, call]);

  // Open: read what the engine has, and make a card when there is none or it is old.
  useEffect(() => {
    alive.current = true;
    if (!localAccess || opened.current) return;
    opened.current = true;
    void load().then((value) => {
      if (value !== null && alive.current && shouldStart(value, Date.now())) void check();
    });
    return () => {
      alive.current = false;
      opened.current = false;
    };
  }, [localAccess, load, check]);

  // Follow a run that is going.
  const running = state?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer);
  }, [running, state, load]);

  return { localAccess, state, problem, check };
}
