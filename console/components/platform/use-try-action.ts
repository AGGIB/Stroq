'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import {
  validateTryAction,
  validateTryRequest,
  type TryAction,
  type TryRequest,
} from '@/lib/try-action';

const DEADLINE_MS = 20_000;

export interface TryOutcome {
  /** What was asked. Kept here only, in memory: the server never returns it. */
  readonly request: TryRequest;
  readonly answer: TryAction;
}

/** One made-up action judged by the current policy. Nothing is stored, here or on the server. */
export function useTryAction() {
  const { localAccess, requestLocal } = usePlatform();
  const [outcome, setOutcome] = useState<TryOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);

  const check = useCallback(
    async (request: TryRequest) => {
      if (!localAccess || !validateTryRequest(request)) return;
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
      setBusy(true);
      setError(null);
      try {
        const value = await requestLocal('/api/policy/try', request, controller.signal);
        if (!validateTryAction(value) || value.kind !== request.kind)
          throw new Error('Unsupported result. Nothing was accepted.');
        if (active.current === controller) setOutcome({ request, answer: value });
      } catch (e) {
        // The last good answer stays visible, marked by the error under the form.
        if (active.current === controller)
          setError(
            e instanceof Error && e.name !== 'AbortError'
              ? e.message
              : 'The check took too long and was stopped. Nothing was run.',
          );
      } finally {
        clearTimeout(timer);
        if (active.current === controller) {
          active.current = null;
          setBusy(false);
        }
      }
    },
    [localAccess, requestLocal],
  );

  useEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
    },
    [],
  );

  return { outcome, busy, error, check, localAccess };
}
