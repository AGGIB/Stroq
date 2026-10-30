'use client';
import { useEffect, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import { THREAT_SOURCE, validateThreatFeed, type ThreatFeed } from '@/lib/threat-feed';
import { threatFeedOn } from '@/lib/threat-words';

/** The server may spend up to 20 seconds on the download; the page waits a little longer. */
const DEADLINE_MS = 30_000;

export interface ThreatFeedState {
  /** Whether the feed is on in this browser; null until the page has looked. */
  readonly on: boolean | null;
  readonly feed: ThreatFeed | null;
  readonly loading: boolean;
  readonly failed: boolean;
}

/**
 * pwn.watch's incidents that match this project, asked of the console's own server, and only once the
 * feed is on in this browser: off, nothing is asked and nothing is downloaded. Read once per visit.
 */
export function useThreatFeed(): ThreatFeedState {
  const { localAccess, requestLocal } = usePlatform();
  const [on, setOn] = useState<boolean | null>(null);
  const [feed, setFeed] = useState<ThreatFeed | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => setOn(threatFeedOn()), []);

  useEffect(() => {
    if (!localAccess || on !== true) return;
    let active = true;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), DEADLINE_MS);
    setLoading(true);
    requestLocal('/api/threats', { source: THREAT_SOURCE }, controller.signal)
      .then((value) => {
        if (!active) return;
        const ok = validateThreatFeed(value);
        setFeed(ok ? value : null);
        setFailed(!ok);
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        clearTimeout(deadline);
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      clearTimeout(deadline);
      controller.abort();
    };
  }, [localAccess, on, requestLocal]);

  return { on, feed, loading, failed };
}
