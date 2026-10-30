'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import {
  applyTail,
  cursorToken,
  validateJournalSummary,
  validateJournalTail,
  type JournalCursor,
  type JournalRow,
  type JournalSummary,
  type JournalTail,
  type LiveEntry,
} from '@/lib/journal-view';
import { notificationFor } from '@/lib/live-notify';

const POLL_MS = 2000;
const SUMMARY_MS = 15_000;
const DEADLINE_MS = 10_000;
const MAX_FAILURES = 5;
const MAX_ROWS = 300;
const FRESH_MS = 2500;

export type LiveState = 'connecting' | 'live' | 'paused' | 'missing' | 'refused' | 'error';

export type LiveRow = LiveEntry;

/** `unsupported`: no Notification in this browser. `blocked`: the person refused it in the browser. */
export type NotifyState = 'unsupported' | 'off' | 'on' | 'blocked';
const NOTIFY_KEY = 'stroq-live-notify';

function initialNotify(): NotifyState {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  try {
    return Notification.permission === 'granted' && window.localStorage.getItem(NOTIFY_KEY) === '1'
      ? 'on'
      : 'off';
  } catch {
    return 'off';
  }
}

/** Follows the audit journal by polling a cursor. It reads only; it never starts or changes anything. */
export function useJournalLive() {
  const { localAccess, requestLocal } = usePlatform();
  const [rows, setRows] = useState<readonly LiveRow[]>([]);
  const [summary, setSummary] = useState<JournalSummary | null>(null);
  const [state, setState] = useState<LiveState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [gap, setGap] = useState(false);
  const [paused, setPaused] = useState(false);
  const [polledAt, setPolledAt] = useState<number | null>(null);
  const head = useRef<JournalCursor | null>(null);
  const failures = useRef(0);
  const pausedRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const run = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  const summaryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const summaryAlive = useRef(true);
  const soonSummaryRef = useRef<() => void>(() => undefined);
  const [notify, setNotify] = useState<NotifyState>('off');
  const notifyRef = useRef<NotifyState>('off');
  useEffect(() => {
    const initial = initialNotify();
    notifyRef.current = initial;
    setNotify(initial);
  }, []);

  const read = useCallback(
    async (path: string, body: unknown) => {
      const controller = new AbortController();
      inFlight.current = controller;
      const deadline = setTimeout(() => controller.abort(), DEADLINE_MS);
      try {
        return await requestLocal(path, body, controller.signal);
      } finally {
        clearTimeout(deadline);
        if (inFlight.current === controller) inFlight.current = null;
      }
    },
    [requestLocal],
  );

  const loadSummary = useCallback(async () => {
    const value = await read('/api/journal/summary', undefined);
    if (!validateJournalSummary(value))
      throw new Error('Unsupported journal summary. Nothing was accepted.');
    return value;
  }, [read]);

  const poll = useCallback(
    async (generation: number) => {
      if (generation !== run.current) return;
      let more = false;
      try {
        const value = await read('/api/journal/tail', {
          after: head.current === null ? null : cursorToken(head.current),
        });
        if (generation !== run.current) return;
        if (!validateJournalTail(value))
          throw new Error('Unsupported journal reply. Nothing was accepted.');
        const tail: JournalTail = value;
        failures.current = 0;
        setError(null);
        setPolledAt(Date.now());
        if (tail.state !== 'ready') {
          head.current = null;
          setRows([]);
          setState(tail.state);
        } else {
          setState(pausedRef.current ? 'paused' : 'live');
          const replace = tail.cursor !== 'ok';
          setGap(tail.cursor === 'gap');
          head.current = tail.head;
          if (replace || tail.rows.length > 0) {
            setRows((current) => applyTail(current, tail, MAX_ROWS).entries);
            if (!replace) {
              setTimeout(() => setRows((c) => c.map((e) => ({ ...e, fresh: false }))), FRESH_MS);
              soonSummaryRef.current();
              if (notifyRef.current === 'on' && document.hidden) {
                const note = notificationFor(tail.rows);
                if (note) new Notification(note.title, { body: note.body, tag: 'stroq-live' });
              }
            }
          }
          more = tail.rows.length >= 100;
        }
      } catch (e) {
        if (generation !== run.current) return;
        failures.current += 1;
        setError(
          e instanceof Error && e.name !== 'AbortError'
            ? e.message
            : 'The journal did not answer in time.',
        );
        if (failures.current >= MAX_FAILURES) {
          setState('error');
          return;
        }
      }
      if (generation !== run.current || pausedRef.current) return;
      const wait = more ? 0 : POLL_MS * (1 + failures.current);
      timer.current = setTimeout(() => void poll(generation), wait);
    },
    [read],
  );

  const stop = useCallback(() => {
    run.current += 1;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    inFlight.current?.abort();
  }, []);

  const start = useCallback(
    (keepCursor = false) => {
      stop();
      const generation = run.current;
      failures.current = 0;
      if (!keepCursor) head.current = null;
      setState(keepCursor ? 'live' : 'connecting');
      setError(null);
      void poll(generation);
    },
    [poll, stop],
  );

  // Follow the journal while the page is open and the person has not paused it.
  useEffect(() => {
    if (!localAccess) return;
    start(false);
    const onVisibility = () => {
      // With notifications on, the page keeps following the journal while its tab is in the background.
      if (document.hidden && notifyRef.current !== 'on') {
        stop();
      } else if (!pausedRef.current) {
        start(true);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [localAccess, start, stop]);

  // The counts come from a wider read. They refresh on a slow clock, and soon after new rows arrive,
  // so they do not lag behind the feed.
  const refreshSummary = useCallback(() => {
    if (document.hidden || pausedRef.current) return;
    loadSummary().then(
      (value) => summaryAlive.current && setSummary(value),
      () => undefined,
    );
  }, [loadSummary]);
  const soonSummary = useCallback(() => {
    if (summaryTimer.current !== null) clearTimeout(summaryTimer.current);
    summaryTimer.current = setTimeout(refreshSummary, 600);
  }, [refreshSummary]);
  soonSummaryRef.current = soonSummary;
  useEffect(() => {
    if (!localAccess) return;
    summaryAlive.current = true;
    refreshSummary();
    const id = setInterval(refreshSummary, SUMMARY_MS);
    return () => {
      summaryAlive.current = false;
      clearInterval(id);
      if (summaryTimer.current !== null) clearTimeout(summaryTimer.current);
    };
  }, [localAccess, refreshSummary]);

  const togglePause = useCallback(() => {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (next) {
      stop();
      setState('paused');
    } else {
      start(true);
    }
  }, [start, stop]);

  const setNotifications = useCallback(async (wanted: boolean) => {
    if (typeof Notification === 'undefined') return;
    let next: NotifyState = 'off';
    if (wanted) {
      const permission =
        Notification.permission === 'default'
          ? await Notification.requestPermission()
          : Notification.permission;
      next = permission === 'granted' ? 'on' : permission === 'denied' ? 'blocked' : 'off';
    }
    try {
      window.localStorage.setItem(NOTIFY_KEY, next === 'on' ? '1' : '0');
    } catch {
      /* The choice lasts until the page closes. */
    }
    notifyRef.current = next;
    setNotify(next);
  }, []);

  return {
    notify,
    setNotifications,
    localAccess,
    rows,
    summary,
    state: paused && state === 'live' ? 'paused' : state,
    error,
    gap,
    paused,
    polledAt,
    togglePause,
    retry: () => start(false),
  };
}
