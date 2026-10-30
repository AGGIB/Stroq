'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import type { Incident } from '@/lib/incidents';
import { SessionTaintRefusal } from '@/lib/session-taint-error';
import {
  SESSION_TAINT_ERROR_MESSAGES,
  validateSessionTaintReceipt,
  validateSessionTaintState,
  type SessionTaintInspection,
  type SessionTaintPreview,
  type SessionTaintRecord,
  type SessionTaintReceipt,
  type SessionTaintState,
} from '@/lib/session-taint';
import {
  sessionTaintKey,
  sessionTaintInspectionMatches,
  sessionTaintPreviewMatches,
  sessionTaintReceiptMatches,
  sameSessionTaintRecord,
  sessionTaintRecordMatchesPreview,
  sessionTaintPendingWrites,
  sessionTaintConfirmRecheck,
  sessionTaintObservedUnfinished,
} from '@/lib/session-taint-binding';

type Operation = 'load' | 'inspect' | 'preview' | 'clear' | 'recheck';
type Ack = { effects: boolean; retention: boolean };
const emptyAck = (): Ack => ({ effects: false, retention: false });
const unfinished = (record: SessionTaintRecord) =>
  record.status === 'prepared' || record.status === 'uncertain';
const UNKNOWN = 'Completion is unknown. Recheck this session change before clearing again.';
export function useSessionTaint(incident: Incident | null) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
  const selection = sessionTaintKey(incident, workspaceId);
  const identity = useRef({ selection, localContext, requestLocal, generation: 0 });
  if (
    identity.current.selection !== selection ||
    identity.current.localContext !== localContext ||
    identity.current.requestLocal !== requestLocal
  )
    identity.current = {
      selection,
      localContext,
      requestLocal,
      generation: identity.current.generation + 1,
    };
  const key = selection ? `${selection}:${identity.current.generation}` : null;
  const mounted = useRef(false),
    current = useRef(key);
  current.current = key;
  const active = useRef<{
    key: string;
    operation: Operation;
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [snapshot, setSnapshot] = useState<{ key: string; value: SessionTaintState } | null>(null);
  const [measurement, setMeasurement] = useState<{
    key: string;
    value: SessionTaintInspection | null;
  } | null>(null);
  const [plan, setPlan] = useState<{ key: string; value: SessionTaintPreview } | null>(null);
  const [consent, setConsent] = useState<{ id: string; value: Ack } | null>(null);
  const [progress, setProgress] = useState<{ key: string; operation: Operation } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [dialog, setDialog] = useState<string | null>(null);
  const [completion, setCompletion] = useState<{ key: string; value: SessionTaintReceipt } | null>(
    null,
  );
  const [, changed] = useState(0);
  const state = key && snapshot?.key === key ? snapshot.value : null;
  const inspection = key && measurement?.key === key ? measurement.value : null;
  const preview = key && plan?.key === key ? plan.value : null;
  const ack = preview && consent?.id === preview.id ? consent.value : emptyAck();
  const busy = key && progress?.key === key ? progress.operation : null;
  const pending = sessionTaintPendingWrites(requestLocal);
  const observed = sessionTaintObservedUnfinished(requestLocal);
  const unresolved = [...pending.values()].filter(
    (write) => write.preview.inspection.workspaceId === workspaceId,
  );
  const unresolvedRecords = [...observed.values()].filter(
    (record) => record.before.workspaceId === workspaceId,
  );
  const needsRecheck = unresolved.length > 0 || unresolvedRecords.length > 0;
  const latest = useRef({ state, inspection, preview, ack });
  latest.current = { state, inspection, preview, ack };
  const clearPlan = useCallback(() => {
    latest.current.preview = null;
    latest.current.ack = emptyAck();
    setPlan(null);
    setConsent(null);
  }, []);
  const begin = useCallback(
    (operation: Operation, preserveFailure = false) => {
      if (!mounted.current || !key || current.current !== key || active.current) return null;
      const controller = new AbortController();
      const record = {
        key,
        operation,
        controller,
        timer: undefined! as ReturnType<typeof setTimeout>,
      };
      const accepts = () => mounted.current && current.current === key && active.current === record;
      record.timer = setTimeout(
        () => {
          if (!accepts()) return;
          controller.abort();
          active.current = null;
          setProgress(null);
          clearPlan();
          setFailure({
            key,
            message:
              operation === 'clear'
                ? UNKNOWN
                : 'The local read timed out. Inspect or recheck again.',
          });
        },
        operation === 'clear' ? 60_000 : 30_000,
      );
      active.current = record;
      setProgress({ key, operation });
      if (!preserveFailure) setFailure(null);
      return {
        record,
        accepts,
        valid: () => accepts() && !controller.signal.aborted,
        finish: () => {
          clearTimeout(record.timer);
          if (active.current === record) {
            active.current = null;
            setProgress(null);
          }
        },
      };
    },
    [key, clearPlan],
  );
  const refresh = useCallback(
    async (preserveFailure = false) => {
      const request = begin('load', preserveFailure);
      if (!request || !key || !workspaceId) return;
      try {
        const value = await requestLocal(
          '/api/session-taint',
          undefined,
          request.record.controller.signal,
        );
        if (!request.valid()) return;
        if (!validateSessionTaintState(value) || value.workspaceId !== workspaceId) throw Error();
        for (const record of value.records)
          if (unfinished(record) && !observed.has(record.id)) observed.set(record.id, record);
        latest.current.state = value;
        setSnapshot({ key, value });
      } catch {
        if (request.accepts()) {
          latest.current.state = null;
          setSnapshot(null);
          setFailure({
            key,
            message: 'Session change history could not be verified. Refresh before clearing taint.',
          });
        }
      } finally {
        request.finish();
      }
    },
    [begin, key, workspaceId, requestLocal],
  );
  useEffect(() => {
    mounted.current = true;
    clearPlan();
    setMeasurement(null);
    setDialog(null);
    setFailure(null);
    setProgress(null);
    setCompletion(null);
    return () => {
      mounted.current = false;
      if (active.current) {
        active.current.controller.abort();
        clearTimeout(active.current.timer);
      }
      active.current = null;
    };
  }, [key, clearPlan]);
  useEffect(() => {
    if (key) void refresh();
  }, [key, refresh]);
  useEffect(() => {
    if (!key || !preview) return;
    const timer = setTimeout(
      () => {
        if (current.current !== key || latest.current.preview !== preview) return;
        clearPlan();
        setFailure({ key, message: 'Preview expired. Inspect the session and preview again.' });
      },
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [key, preview, clearPlan]);
  const inspect = async () => {
    if (!incident || !workspaceId) return;
    const request = begin('inspect');
    if (!request || !key) return;
    clearPlan();
    latest.current.inspection = null;
    setMeasurement(null);
    const startedAt = new Date().toISOString();
    try {
      const value = await requestLocal(
        '/api/session-taint/inspect',
        { id: incident.id, expectedEvidenceSha: incident.evidenceSha },
        request.record.controller.signal,
      );
      if (!request.valid()) return;
      if (
        !sessionTaintInspectionMatches(value, incident, workspaceId) ||
        value.checkedAt < startedAt
      )
        throw Error();
      latest.current.inspection = value;
      setMeasurement({ key, value });
    } catch (error) {
      if (request.accepts())
        setFailure({
          key,
          message: finiteMessage(
            error,
            'This finding’s current session state could not be verified.',
          ),
        });
    } finally {
      request.finish();
    }
  };
  const blocked = () =>
    latest.current.state?.records.some(unfinished) ||
    [...observed.values()].some((record) => record.before.workspaceId === workspaceId) ||
    [...pending.values()].some((write) => write.preview.inspection.workspaceId === workspaceId);
  const prepare = async () => {
    const measured = latest.current.inspection;
    if (
      !key ||
      !workspaceId ||
      !incident ||
      !latest.current.state?.available ||
      blocked() ||
      !measured ||
      measured.taint.status !== 'suspect' ||
      measured.provenance.pending > 0
    )
      return;
    const request = begin('preview');
    if (!request) return;
    clearPlan();
    setDialog(key);
    try {
      const value = await requestLocal(
        '/api/session-taint/preview',
        {
          id: incident.id,
          expectedEvidenceSha: incident.evidenceSha,
          expectedRevisionSha256: measured.revisionSha256,
        },
        request.record.controller.signal,
      );
      if (!request.valid()) return;
      if (
        !sessionTaintPreviewMatches(value, measured) ||
        Date.parse(value.expiresAt) <= Date.now() ||
        Date.parse(value.createdAt) > Date.now()
      )
        throw Error();
      latest.current.preview = value;
      setPlan({ key, value });
    } catch (error) {
      if (request.accepts())
        setFailure({
          key,
          message: finiteMessage(
            error,
            'This exact session change could not be previewed. Inspect again.',
          ),
        });
    } finally {
      request.finish();
    }
  };
  const acknowledge = (name: keyof Ack, value: boolean) => {
    if (
      !mounted.current ||
      !key ||
      current.current !== key ||
      active.current ||
      !preview ||
      latest.current.preview !== preview ||
      Date.parse(preview.expiresAt) <= Date.now()
    )
      return;
    latest.current.ack = { ...latest.current.ack, [name]: value };
    setConsent({ id: preview.id, value: latest.current.ack });
  };
  const acceptReceipt = (value: SessionTaintReceipt) => {
    if (!key || !workspaceId || !incident) return;
    setCompletion({ key, value });
    if (sessionTaintInspectionMatches(value.record.before, incident, workspaceId)) {
      latest.current.inspection = value.record.current;
      setMeasurement({ key, value: value.record.current });
    }
    const previous = latest.current.state;
    if (previous?.available) {
      const next = {
        ...previous,
        generatedAt: value.checkedAt,
        history: 'ready' as const,
        records: [
          value.record,
          ...previous.records.filter((record) => record.id !== value.record.id),
        ].slice(0, 32),
      };
      latest.current.state = next;
      setSnapshot({ key, value: next });
    }
  };
  const apply = async () => {
    if (
      !key ||
      !workspaceId ||
      !preview ||
      latest.current.preview !== preview ||
      !latest.current.ack.effects ||
      !latest.current.ack.retention ||
      !latest.current.state?.available ||
      blocked() ||
      Date.parse(preview.expiresAt) <= Date.now() ||
      pending.size >= 64
    )
      return;
    const request = begin('clear');
    if (!request) return;
    const startedAt = new Date().toISOString();
    pending.set(preview.recordId, { preview, startedAt });
    changed((n) => n + 1);
    clearPlan();
    let refused = false;
    try {
      const value = await requestLocal(
        '/api/session-taint/clear',
        {
          previewId: preview.id,
          acknowledgeWeakenRestrictions: true,
          acknowledgeRecoveryRetention: true,
        },
        request.record.controller.signal,
      );
      if (!request.valid()) return;
      if (!sessionTaintReceiptMatches(value, preview, startedAt)) throw Error();
      pending.delete(preview.recordId);
      changed((n) => n + 1);
      acceptReceipt(value);
      setDialog(null);
    } catch (error) {
      if (request.accepts()) {
        if (error instanceof SessionTaintRefusal) {
          pending.delete(preview.recordId);
          changed((n) => n + 1);
          latest.current.inspection = null;
          setMeasurement(null);
          refused = true;
          setFailure({ key, message: error.message });
        } else setFailure({ key, message: UNKNOWN });
        setDialog(null);
      }
    } finally {
      request.finish();
      if (refused) void refresh(true);
    }
  };
  const recheck = async (recordId: string) => {
    if (!key || !workspaceId) return;
    const write = pending.get(recordId),
      record =
        observed.get(recordId) ??
        latest.current.state?.records.find((value) => value.id === recordId);
    if (
      (!write || write.preview.inspection.workspaceId !== workspaceId) &&
      (!record || record.before.workspaceId !== workspaceId)
    )
      return;
    const request = begin('recheck');
    if (!request) return;
    clearPlan();
    const startedAt = new Date().toISOString();
    try {
      const value = await requestLocal(
        '/api/session-taint/recheck',
        { recordId },
        request.record.controller.signal,
      );
      if (!request.valid()) return;
      if (
        !validateSessionTaintReceipt(value) ||
        value.operation !== 'recheck' ||
        value.record.before.workspaceId !== workspaceId ||
        value.record.id !== recordId ||
        value.checkedAt < startedAt ||
        (write
          ? !sessionTaintRecordMatchesPreview(value.record, write.preview)
          : !sameSessionTaintRecord(value.record, record!))
      )
        throw Error();
      sessionTaintConfirmRecheck(requestLocal, value);
      changed((n) => n + 1);
      acceptReceipt(value);
    } catch {
      if (request.accepts())
        setFailure({
          key,
          message:
            'This exact session change could not be rechecked. Completion remains unverified.',
        });
    } finally {
      request.finish();
    }
  };
  return {
    workspaceId,
    state,
    inspection,
    preview,
    ack,
    busy,
    needsRecheck,
    unresolved,
    unresolvedRecords,
    records:
      state?.records.filter(
        (record) =>
          incident && sessionTaintInspectionMatches(record.before, incident, workspaceId!),
      ) ?? [],
    receipt: key && completion?.key === key ? completion.value : null,
    error: key && failure?.key === key ? failure.message : null,
    open: key !== null && dialog === key,
    canPrepare:
      !!state?.available &&
      !busy &&
      !needsRecheck &&
      inspection?.taint.status === 'suspect' &&
      inspection.provenance.pending === 0,
    refresh,
    inspect,
    prepare,
    acknowledge,
    apply,
    recheck,
    close: () => {
      if (!mounted.current || current.current !== key || active.current?.operation === 'clear')
        return;
      clearPlan();
      setDialog(null);
    },
  };
}
function finiteMessage(error: unknown, fallback: string) {
  return error instanceof Error &&
    Object.values(SESSION_TAINT_ERROR_MESSAGES).includes(error.message)
    ? error.message
    : fallback;
}
