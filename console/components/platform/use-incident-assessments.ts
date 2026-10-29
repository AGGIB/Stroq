'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import type { Incident } from '@/lib/incidents';
import {
  INCIDENT_ASSESSMENT_LABELS,
  assessmentReasonMatches,
  validateIncidentAssessmentPreview,
  validateIncidentAssessmentReceipt,
  validateIncidentAssessmentState,
  sameIncidentAssessmentBinding,
  incidentAssessmentMatchesPreview,
  latestIncidentAssessment,
  type IncidentAssessmentDecision,
  type IncidentAssessmentReason,
  type IncidentAssessmentReceipt,
  type IncidentAssessmentState,
} from '@/lib/incident-assessments';

type Operation = 'load' | 'preview' | 'apply' | 'recheck';
type Choice = {
  assessment: IncidentAssessmentDecision | null;
  reason: IncidentAssessmentReason | null;
};
export { incidentAssessmentPendingWrites } from '@/lib/incident-assessment-client-state';
import {
  pendingWrites,
  incidentAssessmentPendingWrites,
  PENDING_LIMIT,
  emptyChoice,
  UNKNOWN,
  bindingFor,
  finiteMessage,
} from '@/lib/incident-assessment-client-state';
export function useIncidentAssessments(incident: Incident | null) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const connected = localAccess && !!localContext?.workspace.id;
  const identity = useRef({ connected, localContext, requestLocal, generation: 0 });
  if (
    identity.current.connected !== connected ||
    identity.current.localContext !== localContext ||
    identity.current.requestLocal !== requestLocal
  )
    identity.current = {
      connected,
      localContext,
      requestLocal,
      generation: identity.current.generation + 1,
    };
  const key = connected ? `journal:${identity.current.generation}` : null;
  const binding = bindingFor(incident),
    selection = binding ? JSON.stringify(binding) : null;
  const selectedKey = key && selection ? `${key}:${selection}` : null;
  const mounted = useRef(false),
    currentKey = useRef(key),
    currentSelection = useRef(selectedKey);
  currentKey.current = key;
  currentSelection.current = selectedKey;
  const active = useRef<{
    key: string;
    selection: string | null;
    operation: Operation;
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [capture, setCapture] = useState<{ key: string; value: IncidentAssessmentState } | null>(
    null,
  );
  const [progress, setProgress] = useState<{ key: string; operation: Operation } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [dialog, setDialog] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ key: string; value: Choice } | null>(null);
  const [completion, setCompletion] = useState<{
    key: string;
    value: IncidentAssessmentReceipt;
  } | null>(null);
  const [, changed] = useState(0);
  const state = key && capture?.key === key ? capture.value : null;
  const busy = key && progress?.key === key ? progress.operation : null;
  const writes = pendingWrites(requestLocal),
    pending = [...incidentAssessmentPendingWrites(requestLocal).values()];
  const completionUnknown =
    !!binding &&
    pending.some((write) => sameIncidentAssessmentBinding(write.preview.incident, binding));
  const needsRecheck = pending.length > 0;
  const available = !!state && state.history !== 'unavailable';
  const latest = state && binding ? latestIncidentAssessment(state.records, binding) : null;
  const history =
    state && binding
      ? state.records.filter((record) => sameIncidentAssessmentBinding(record.incident, binding))
      : [];
  const choice = selectedKey && draft?.key === selectedKey ? draft.value : emptyChoice();
  const accepted = useRef(state);
  accepted.current = state;
  const latestChoice = useRef(choice);
  latestChoice.current = choice;
  const open = selectedKey !== null && dialog === selectedKey;
  const dialogKey = useRef(dialog);
  dialogKey.current = dialog;
  const begin = useCallback(
    (operation: Operation, expectedSelection: string | null = null) => {
      if (
        !mounted.current ||
        !key ||
        currentKey.current !== key ||
        active.current ||
        (operation !== 'load' &&
          (!expectedSelection || currentSelection.current !== expectedSelection))
      )
        return null;
      const record = {
        key,
        selection: expectedSelection,
        operation,
        controller: new AbortController(),
        timer: undefined! as ReturnType<typeof setTimeout>,
      };
      const accepts = () =>
        mounted.current &&
        currentKey.current === key &&
        active.current === record &&
        (record.operation === 'load' || currentSelection.current === record.selection);
      const arm = (duration: number) => {
        clearTimeout(record.timer);
        record.timer = setTimeout(() => {
          if (!accepts()) return;
          record.controller.abort();
          active.current = null;
          setProgress(null);
          if (record.operation === 'load') {
            accepted.current = null;
            setCapture(null);
          }
          setFailure({
            key,
            message:
              record.operation === 'apply'
                ? UNKNOWN
                : 'Assessment read timed out. Refresh or recheck explicitly.',
          });
        }, duration);
      };
      active.current = record;
      setProgress({ key, operation });
      setFailure(null);
      arm(30_000);
      return {
        record,
        accepts,
        valid: () => accepts() && !record.controller.signal.aborted,
        applying: () => {
          record.operation = 'apply';
          setProgress({ key, operation: 'apply' });
          arm(60_000);
        },
        finish: () => {
          clearTimeout(record.timer);
          if (active.current === record) {
            active.current = null;
            setProgress(null);
          }
        },
      };
    },
    [key],
  );
  const refresh = useCallback(async () => {
    const run = begin('load');
    if (!run || !key) return;
    try {
      const value = await requestLocal(
        '/api/incident-assessments',
        undefined,
        run.record.controller.signal,
      );
      if (!run.valid()) return;
      if (!validateIncidentAssessmentState(value)) throw Error();
      accepted.current = value;
      setCapture({ key, value });
    } catch {
      if (run.accepts()) {
        accepted.current = null;
        setCapture(null);
        setFailure({
          key,
          message: 'Assessment history could not be verified. No assessment was inferred.',
        });
      }
    } finally {
      run.finish();
    }
  }, [begin, key, requestLocal]);
  useEffect(() => {
    mounted.current = true;
    accepted.current = null;
    setCapture(null);
    setFailure(null);
    setProgress(null);
    setDialog(null);
    setDraft(null);
    setCompletion(null);
    if (key) void refresh();
    return () => {
      mounted.current = false;
      if (active.current) {
        active.current.controller.abort();
        clearTimeout(active.current.timer);
      }
      active.current = null;
    };
  }, [key, refresh]);
  useEffect(() => {
    setDialog(null);
    setDraft(null);
    setCompletion(null);
    if (active.current && active.current.operation !== 'load') {
      active.current.controller.abort();
      clearTimeout(active.current.timer);
      active.current = null;
      setProgress(null);
    }
  }, [selectedKey]);
  const show = () => {
    if (
      !mounted.current ||
      !selectedKey ||
      !binding ||
      currentKey.current !== key ||
      currentSelection.current !== selectedKey
    )
      return;
    const current = accepted.current
      ? latestIncidentAssessment(accepted.current.records, binding)
      : null;
    const value = current
      ? { assessment: current.assessment, reason: current.reason }
      : emptyChoice();
    latestChoice.current = value;
    setDraft({ key: selectedKey, value });
    dialogKey.current = selectedKey;
    setDialog(selectedKey);
  };
  const setChoice = (
    assessment: IncidentAssessmentDecision | null,
    reason: IncidentAssessmentReason | null,
  ) => {
    if (
      !mounted.current ||
      !selectedKey ||
      currentKey.current !== key ||
      currentSelection.current !== selectedKey ||
      dialogKey.current !== selectedKey ||
      active.current
    )
      return;
    const value: Choice = {
      assessment:
        assessment && Object.hasOwn(INCIDENT_ASSESSMENT_LABELS, assessment) ? assessment : null,
      reason: assessmentReasonMatches(assessment, reason) ? reason : null,
    };
    latestChoice.current = value;
    setDraft({ key: selectedKey, value });
  };
  const eligible = (value: Choice, snapshot: IncidentAssessmentState | null) => {
    if (
      !binding ||
      !snapshot?.canRecord ||
      snapshot.history === 'unavailable' ||
      writes.size > 0 ||
      !assessmentReasonMatches(value.assessment, value.reason)
    )
      return false;
    const previous = latestIncidentAssessment(snapshot.records, binding);
    return (
      (value.assessment !== 'reopened' ||
        (previous !== null && previous.assessment !== 'reopened')) &&
      !(previous?.assessment === value.assessment && previous?.reason === value.reason)
    );
  };
  const save = async () => {
    if (
      !selectedKey ||
      !binding ||
      currentSelection.current !== selectedKey ||
      dialogKey.current !== selectedKey ||
      !eligible(latestChoice.current, accepted.current)
    )
      return;
    const snapshot = accepted.current!,
      value = { ...latestChoice.current },
      previous = latestIncidentAssessment(snapshot.records, binding);
    const run = begin('preview', selectedKey);
    if (!run || !key) return;
    let applied = false,
      confirmed = false;
    const preparedAt = new Date().toISOString();
    try {
      const preview = await requestLocal(
        '/api/incident-assessments/preview',
        {
          id: binding.id,
          expectedEvidenceSha: binding.evidenceSha256,
          expectedAssessmentId: previous?.id ?? null,
          assessment: value.assessment,
          reason: value.reason,
        },
        run.record.controller.signal,
      );
      if (!run.valid()) return;
      if (
        !validateIncidentAssessmentPreview(preview) ||
        !sameIncidentAssessmentBinding(preview.incident, binding) ||
        preview.assessment !== value.assessment ||
        preview.reason !== value.reason ||
        preview.previousAssessmentId !== (previous?.id ?? null) ||
        preview.storeRevision !== snapshot.revision ||
        preview.createdAt < preparedAt ||
        Date.parse(preview.createdAt) > Date.now() ||
        Date.parse(preview.expiresAt) <= Date.now()
      )
        throw Error();
      if (
        !run.valid() ||
        dialogKey.current !== selectedKey ||
        accepted.current !== snapshot ||
        !eligible(value, accepted.current) ||
        writes.size >= PENDING_LIMIT
      )
        return;
      const startedAt = new Date().toISOString();
      writes.set(preview.recordId, { preview, startedAt });
      changed((n) => n + 1);
      applied = true;
      run.applying();
      const receipt = await requestLocal(
        '/api/incident-assessments/apply',
        { previewId: preview.id },
        run.record.controller.signal,
      );
      if (!run.valid()) return;
      if (
        !validateIncidentAssessmentReceipt(receipt) ||
        receipt.operation !== 'record' ||
        receipt.status !== 'recorded' ||
        receipt.recordId !== preview.recordId ||
        receipt.expectedEvidenceSha !== binding.evidenceSha256 ||
        receipt.checkedAt < startedAt ||
        !receipt.record ||
        !incidentAssessmentMatchesPreview(receipt.record, preview)
      )
        throw Error();
      writes.delete(preview.recordId);
      changed((n) => n + 1);
      setCompletion({ key, value: receipt });
      dialogKey.current = null;
      setDialog(null);
      setDraft(null);
      confirmed = true;
    } catch (error) {
      if (run.accepts())
        setFailure({
          key,
          message: applied
            ? UNKNOWN
            : finiteMessage(
                error,
                'This exact finding could not be assessed. Refresh and try again.',
              ),
        });
    } finally {
      run.finish();
      if (confirmed) void refresh();
    }
  };
  const recheck = async (recordId: string) => {
    if (!selectedKey || currentSelection.current !== selectedKey) return;
    const write = writes.get(recordId);
    if (!write) return;
    const run = begin('recheck', selectedKey);
    if (!run || !key) return;
    const startedAt = new Date().toISOString();
    let confirmed = false;
    try {
      const receipt = await requestLocal(
        '/api/incident-assessments/recheck',
        { recordId, expectedEvidenceSha: write.preview.incident.evidenceSha256 },
        run.record.controller.signal,
      );
      if (!run.valid()) return;
      if (
        !validateIncidentAssessmentReceipt(receipt) ||
        receipt.operation !== 'recheck' ||
        receipt.recordId !== recordId ||
        receipt.expectedEvidenceSha !== write.preview.incident.evidenceSha256 ||
        receipt.checkedAt < startedAt ||
        receipt.checkedAt < write.startedAt ||
        (receipt.status === 'recorded' &&
          (!receipt.record || !incidentAssessmentMatchesPreview(receipt.record, write.preview)))
      )
        throw Error();
      writes.delete(recordId);
      changed((n) => n + 1);
      setCompletion({ key, value: receipt });
      confirmed = true;
    } catch {
      if (run.accepts())
        setFailure({
          key,
          message: 'This exact assessment could not be rechecked. Saving remains unconfirmed.',
        });
    } finally {
      run.finish();
      if (confirmed) void refresh();
    }
  };
  const close = () => {
    if (
      !mounted.current ||
      currentKey.current !== key ||
      currentSelection.current !== selectedKey ||
      active.current?.operation === 'apply'
    )
      return;
    if (active.current?.operation === 'preview') {
      active.current.controller.abort();
      clearTimeout(active.current.timer);
      active.current = null;
      setProgress(null);
    }
    dialogKey.current = null;
    setDialog(null);
    setDraft(null);
    latestChoice.current = emptyChoice();
  };
  return {
    state,
    available,
    busy,
    error: key && failure?.key === key ? failure.message : null,
    open,
    incident,
    binding,
    latest,
    history,
    pending,
    needsRecheck,
    completionUnknown,
    choice,
    canSave: open && !busy && eligible(choice, state),
    receipt: key && completion?.key === key ? completion.value : null,
    show,
    close,
    setChoice,
    save,
    refresh,
    recheck,
  };
}
export type IncidentAssessmentsAction = ReturnType<typeof useIncidentAssessments>;
