'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import { validateAgentStatus, type AgentStatusState } from '@/lib/agent-status';
import {
  validateJournalSince,
  validateJournalSummary,
  type JournalSince,
  type JournalSummary,
} from '@/lib/journal-view';
import { browserStorage, openVisit, type Visit } from '@/lib/last-visit';

const DEADLINE_MS = 10_000;

/**
 * The reads the home screen leads with: the agents' hook status and the newest part of the journal.
 * Each is validated on its own; one failing never hides the other. Nothing polls.
 */
export function useProtectionVerdict() {
  const { localAccess, requestLocal } = usePlatform();
  const [agents, setAgents] = useState<AgentStatusState | null>(null);
  const [journal, setJournal] = useState<JournalSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const run = useRef(0);

  const load = useCallback(async () => {
    const generation = ++run.current;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), DEADLINE_MS);
    setLoading(true);
    const [status, summary] = await Promise.allSettled([
      requestLocal('/api/agents', undefined, controller.signal),
      requestLocal('/api/journal/summary', undefined, controller.signal),
    ]);
    clearTimeout(deadline);
    if (generation !== run.current) return;
    const okAgents =
      status.status === 'fulfilled' && validateAgentStatus(status.value) ? status.value : null;
    setAgents(okAgents);
    setJournal(
      summary.status === 'fulfilled' && validateJournalSummary(summary.value)
        ? summary.value
        : null,
    );
    setFailed(okAgents === null);
    setLoading(false);
  }, [requestLocal]);

  useEffect(() => {
    if (!localAccess) return;
    void load();
    return () => {
      run.current += 1;
    };
  }, [localAccess, load]);

  return { localAccess, agents, journal, failed, loading, reload: load };
}

/** Calls `record` once the tab is in view: a page opened in the background has not been seen. */
function whenSeen(record: () => void): (() => void) | undefined {
  if (document.visibilityState === 'visible') {
    record();
    return undefined;
  }
  const onChange = () => {
    if (document.visibilityState !== 'visible') return;
    document.removeEventListener('visibilitychange', onChange);
    record();
  };
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

/**
 * What was recorded since the last visit to this workspace's home screen, kept in this browser only.
 * The visit is recorded only once the page has shown what it came to show, in view: what came since the
 * last visit or, on a first visit, the week. A visit whose read failed records nothing, so the next one
 * still counts from the last visit that was seen.
 */
export function useSinceLastVisit(weekShown: boolean): JournalSince | null {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspace = localContext?.workspace.id ?? null;
  const visit = useRef<{ readonly workspace: string; readonly visit: Visit } | null>(null);
  const [previous, setPrevious] = useState<string | null | undefined>(undefined);
  const [since, setSince] = useState<JournalSince | null>(null);

  useEffect(() => {
    if (!localAccess || workspace === null) return;
    if (visit.current?.workspace !== workspace) {
      visit.current = { workspace, visit: openVisit(new Date(), browserStorage(), workspace) };
      setSince(null);
    }
    const before = visit.current.visit.previous;
    setPrevious(before);
    if (before === null) return;
    let active = true;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), DEADLINE_MS);
    requestLocal('/api/journal/since', { since: before }, controller.signal)
      .then((value) => {
        // An answer about another moment is not about this visit.
        if (active && validateJournalSince(value) && value.since === before) setSince(value);
      })
      .catch(() => {})
      .finally(() => clearTimeout(deadline));
    return () => {
      active = false;
      clearTimeout(deadline);
      controller.abort();
    };
  }, [localAccess, workspace, requestLocal]);

  const shown =
    weekShown &&
    (previous === null || (previous !== undefined && since !== null && since.state === 'ready'));
  useEffect(() => {
    const current = visit.current?.visit;
    if (!shown || current === undefined) return;
    return whenSeen(current.record);
  }, [shown]);

  return since;
}
