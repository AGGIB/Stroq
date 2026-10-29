'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import {
  validateIncidents,
  validateJournalVerification,
  type Incident,
  type IncidentsState,
  type JournalVerification,
} from '@/lib/incidents';
import { validateIncidentComparison, type IncidentComparison } from '@/lib/incident-comparison';
import { closed, hash, stamp } from '@/lib/local-guards';

export function useIncidentEvidence() {
  const { localAccess, requestLocal } = usePlatform();
  const [state, setState] = useState<IncidentsState | null>(null),
    [verification, setVerification] = useState<JournalVerification | null>(null);
  const [comparisons, setComparisons] = useState<IncidentComparison[]>([]);
  const [busy, setBusy] = useState<'load' | 'verify' | 'review' | 'compare' | null>(null),
    [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (!localAccess) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const timer = setTimeout(() => controller.abort(), 15_000);
    setBusy('load');
    setError(null);
    try {
      const value = await requestLocal('/api/incidents', undefined, controller.signal);
      if (!validateIncidents(value))
        throw new Error('Unsupported incident report. No data was accepted.');
      if (active.current === controller) {
        setState(value);
      }
    } catch (e) {
      if (active.current === controller)
        setError(
          e instanceof Error && e.name !== 'AbortError' ? e.message : 'Incident read timed out.',
        );
    } finally {
      clearTimeout(timer);
      if (active.current === controller) setBusy(null);
    }
  }, [localAccess, requestLocal]);
  useEffect(() => {
    void refresh();
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [refresh]);
  const verify = async () => {
    if (busy) return;
    setBusy('verify');
    setError(null);
    const controller = new AbortController();
    active.current = controller;
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const value = await requestLocal('/api/incidents/verify', {}, controller.signal);
      if (!validateJournalVerification(value))
        throw new Error('Unsupported journal verification report.');
      if (active.current === controller) setVerification(value);
    } catch (e) {
      if (active.current === controller)
        setError(
          e instanceof Error && e.name !== 'AbortError'
            ? e.message
            : 'Journal verification timed out. No conclusion was reached.',
        );
    } finally {
      clearTimeout(timer);
      if (active.current === controller) setBusy(null);
    }
  };
  const review = async (incident: Incident) => {
    if (busy) return;
    setBusy('review');
    setError(null);
    const controller = new AbortController();
    active.current = controller;
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const status = incident.status === 'open' ? 'reviewed' : 'open';
      const value = await requestLocal(
        '/api/incidents/review',
        { id: incident.id, expectedEvidenceSha: incident.evidenceSha, status },
        controller.signal,
      );
      if (active.current !== controller) return;
      if (
        !closed(value, ['id', 'evidenceSha', 'status', 'reviewedAt']) ||
        value.id !== incident.id ||
        !hash(value.evidenceSha) ||
        value.evidenceSha !== incident.evidenceSha ||
        value.status !== status ||
        !(status === 'reviewed' ? stamp(value.reviewedAt) : value.reviewedAt === null)
      )
        throw new Error('Review acknowledgement could not be verified. Refresh before retrying.');
      await refresh();
    } catch (e) {
      if (active.current === controller)
        setError(
          e instanceof Error && e.name !== 'AbortError'
            ? e.message
            : 'No acknowledgement received. Refresh to check review status.',
        );
    } finally {
      clearTimeout(timer);
      if (active.current === controller) setBusy(null);
    }
  };
  const compare = async (incident: Incident) => {
    if (busy) return;
    setBusy('compare');
    setError(null);
    const controller = new AbortController();
    active.current = controller;
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const value = await requestLocal(
        '/api/incidents/compare',
        { id: incident.id, expectedEvidenceSha: incident.evidenceSha },
        controller.signal,
      );
      if (
        !validateIncidentComparison(value) ||
        value.incidentId !== incident.id ||
        value.evidenceSha !== incident.evidenceSha
      )
        throw new Error('Unsupported policy comparison. No result was accepted.');
      if (active.current === controller)
        setComparisons((previous) =>
          [...previous.filter((item) => item.incidentId !== value.incidentId), value].slice(-8),
        );
    } catch (e) {
      if (active.current === controller)
        setError(
          `Journal #${incident.sequence}: ${e instanceof Error && e.name !== 'AbortError' ? e.message : 'Policy comparison timed out. No conclusion was reached.'}`,
        );
    } finally {
      clearTimeout(timer);
      if (active.current === controller) setBusy(null);
    }
  };
  return {
    localAccess,
    state,
    verification,
    comparisons,
    busy,
    error,
    refresh,
    verify,
    review,
    compare,
  };
}
