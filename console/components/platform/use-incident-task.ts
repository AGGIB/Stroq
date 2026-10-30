'use client';
import { useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import type { Incident } from '@/lib/incidents';
import { validateIncidentTaskReport, type IncidentTaskReport } from '@/lib/incident-task';
import { incidentTaskKey, incidentTaskReportMatches } from '@/lib/incident-task-binding';

export function useIncidentTask(incident: Incident | null) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
  const selectedKey = incidentTaskKey(incident, workspaceId);
  const connection = useRef({ requestLocal, context: localContext, generation: 0, selectedKey });
  if (
    connection.current.requestLocal !== requestLocal ||
    connection.current.context !== localContext ||
    connection.current.selectedKey !== selectedKey
  ) {
    connection.current.requestLocal = requestLocal;
    connection.current.context = localContext;
    connection.current.generation += 1;
    connection.current.selectedKey = selectedKey;
  }
  const key = selectedKey ? `${selectedKey}:${connection.current.generation}` : null;
  const current = useRef({ key, requestLocal });
  current.current = { key, requestLocal };
  const active = useRef<{
    key: string;
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const accepted = useRef<{ key: string; report: IncidentTaskReport } | null>(null);
  const [capture, setCapture] = useState<{ key: string; report: IncidentTaskReport } | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  useEffect(() => {
    accepted.current = null;
    setCapture(null);
    setFailure(null);
    setPendingKey(null);
    return () => {
      const pending = active.current;
      if (pending) {
        pending.controller.abort();
        clearTimeout(pending.timer);
      }
      active.current = null;
      accepted.current = null;
    };
  }, [key]);
  const resolve = async () => {
    if (
      !key ||
      !incident ||
      !workspaceId ||
      current.current.key !== key ||
      current.current.requestLocal !== requestLocal ||
      active.current
    )
      return;
    const controller = new AbortController();
    const record = { key, controller, timer: undefined! as ReturnType<typeof setTimeout> };
    const accepts = () =>
      current.current.key === key &&
      current.current.requestLocal === requestLocal &&
      active.current === record;
    record.timer = setTimeout(() => {
      if (!accepts()) return;
      controller.abort();
      active.current = null;
      setPendingKey(null);
      setFailure({
        key,
        message: 'Task lookup timed out. No permission association was accepted.',
      });
    }, 25_000);
    active.current = record;
    accepted.current = null;
    setCapture(null);
    setFailure(null);
    setPendingKey(key);
    try {
      const value = await requestLocal(
        '/api/incidents/task',
        { id: incident.id, expectedEvidenceSha: incident.evidenceSha },
        controller.signal,
      );
      if (!accepts() || controller.signal.aborted) return;
      if (
        !validateIncidentTaskReport(value) ||
        !incidentTaskReportMatches(value, incident, workspaceId)
      )
        throw new Error();
      accepted.current = { key, report: value };
      setCapture({ key, report: value });
    } catch {
      if (accepts())
        setFailure({
          key,
          message:
            'The selected finding could not be linked to a verified permission. Recheck to retry.',
        });
    } finally {
      clearTimeout(record.timer);
      if (active.current === record) {
        active.current = null;
        setPendingKey(null);
      }
    }
  };
  const getReport = () =>
    key &&
    current.current.key === key &&
    current.current.requestLocal === requestLocal &&
    accepted.current?.key === key
      ? accepted.current.report
      : null;
  return {
    workspaceId,
    report: key && capture?.key === key ? capture.report : null,
    loading: key !== null && pendingKey === key,
    error: key && failure?.key === key ? failure.message : null,
    resolve,
    getReport,
  };
}
