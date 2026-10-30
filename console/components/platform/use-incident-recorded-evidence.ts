'use client';
import { useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import { validateIncident, type Incident } from '@/lib/incidents';
import {
  validateIncidentRecordedEvidence,
  type IncidentRecordedEvidence,
} from '@/lib/incident-recorded-evidence';

type Capture = {
  key: string;
  report: IncidentRecordedEvidence | null;
  loading: boolean;
  error: string | null;
};

/** One read for the open finding; no table-row requests, polling or mutation. */
export function useIncidentRecordedEvidence(incident: Incident | null) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspace = localAccess ? localContext?.workspace.id : null;
  const selected =
    incident &&
    validateIncident(incident) &&
    workspace &&
    /^workspace-[a-f0-9]{24}$/.test(workspace)
      ? JSON.stringify([
          workspace,
          incident.id,
          incident.evidenceSha,
          incident.sequence,
          incident.recordedAt,
          incident.kind,
        ])
      : null;
  const connection = useRef({ requestLocal, context: localContext, selected, generation: 0 });
  if (
    connection.current.requestLocal !== requestLocal ||
    connection.current.context !== localContext ||
    connection.current.selected !== selected
  ) {
    connection.current = {
      requestLocal,
      context: localContext,
      selected,
      generation: connection.current.generation + 1,
    };
  }
  const key = selected ? `${selected}:${connection.current.generation}` : null;
  const current = useRef({ key, requestLocal, live: true });
  current.current = { ...current.current, key, requestLocal };
  const active = useRef<{
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const accepted = useRef<{ key: string; report: IncidentRecordedEvidence } | null>(null);
  const [capture, setCapture] = useState<Capture | null>(null);

  const refresh = async () => {
    if (
      !key ||
      !incident ||
      !current.current.live ||
      current.current.key !== key ||
      current.current.requestLocal !== requestLocal ||
      active.current
    )
      return;
    const controller = new AbortController();
    const attempt = { controller, timer: undefined! as ReturnType<typeof setTimeout> };
    const accepts = () =>
      current.current.live &&
      current.current.key === key &&
      current.current.requestLocal === requestLocal &&
      active.current === attempt;
    active.current = attempt;
    accepted.current = null;
    setCapture({ key, report: null, loading: true, error: null });
    attempt.timer = setTimeout(() => {
      if (!accepts()) return;
      controller.abort();
      active.current = null;
      setCapture({
        key,
        report: null,
        loading: false,
        error: 'Recorded evidence timed out. Refresh to retry.',
      });
    }, 25_000);
    try {
      const report = await requestLocal(
        '/api/incidents/evidence',
        { id: incident.id, expectedEvidenceSha: incident.evidenceSha },
        controller.signal,
      );
      if (!accepts() || controller.signal.aborted) return;
      if (
        !validateIncidentRecordedEvidence(report) ||
        report.binding.id !== incident.id ||
        report.binding.evidenceSha !== incident.evidenceSha ||
        report.binding.sequence !== incident.sequence ||
        report.binding.recordedAt !== incident.recordedAt ||
        report.binding.kind !== incident.kind
      )
        throw Error('invalid-report');
      accepted.current = { key, report };
      setCapture({ key, report, loading: false, error: null });
    } catch {
      if (accepts())
        setCapture({
          key,
          report: null,
          loading: false,
          error: 'Recorded evidence unavailable. Refresh to retry.',
        });
    } finally {
      clearTimeout(attempt.timer);
      if (active.current === attempt) active.current = null;
    }
  };
  useEffect(() => {
    current.current.live = true;
    accepted.current = null;
    setCapture(null);
    void refresh();
    return () => {
      current.current.live = false;
      active.current?.controller.abort();
      if (active.current) clearTimeout(active.current.timer);
      active.current = null;
      accepted.current = null;
    };
  }, [key]);
  const getReport = () =>
    key &&
    current.current.live &&
    current.current.key === key &&
    current.current.requestLocal === requestLocal &&
    accepted.current?.key === key
      ? accepted.current.report
      : null;
  return {
    available: key !== null,
    report: key && capture?.key === key ? capture.report : null,
    loading: Boolean(key && capture?.key === key && capture.loading),
    error: key && capture?.key === key ? capture.error : null,
    refresh,
    getReport,
  };
}
export type IncidentRecordedEvidenceAction = ReturnType<typeof useIncidentRecordedEvidence>;
