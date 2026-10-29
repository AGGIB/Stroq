'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import {
  quarantinePreviewMatches,
  quarantineReceiptMatches,
  quarantineSelectionKey,
  quarantineTargetKey,
} from '@/lib/quarantine-binding';
import {
  confirmQuarantineRecheck,
  noteQuarantineWrite,
  unresolvedQuarantine,
} from '@/lib/quarantine-recheck';
import {
  validateSkillQuarantine,
  validateSkillQuarantinePreview,
  validateSkillQuarantineReceipt,
  type SkillQuarantineArtifact,
  type SkillQuarantinePreview,
  type SkillQuarantineReceipt,
} from '@/lib/skill-quarantine';

type Operation = 'preview' | 'apply' | 'recheck';
type Pending = {
  key: string;
  operation: Operation;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
};
export function useQuarantineAction({
  action,
  artifact,
  workspaceId,
  recordId,
  disabled = false,
  onCompleted,
  onRechecked,
}: {
  action: 'quarantine' | 'restore';
  artifact: SkillQuarantineArtifact;
  workspaceId: string;
  recordId?: string;
  disabled?: boolean;
  onCompleted: (receipt: SkillQuarantineReceipt) => void;
  onRechecked?: () => void;
}) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const selection =
    localAccess && localContext?.workspace.id === workspaceId
      ? quarantineSelectionKey(artifact, workspaceId)
      : null;
  const target = selection
    ? [action, quarantineTargetKey(artifact, workspaceId), recordId].join('\0')
    : null;
  const identity = useRef({ target, context: localContext, requestLocal, generation: 0 });
  if (
    identity.current.target !== target ||
    identity.current.context !== localContext ||
    identity.current.requestLocal !== requestLocal
  )
    identity.current = {
      target,
      context: localContext,
      requestLocal,
      generation: identity.current.generation + 1,
    };
  const key = target ? `${target}\0${identity.current.generation}` : null;
  const current = useRef(key),
    mounted = useRef(false),
    active = useRef<Pending | null>(null);
  current.current = key;
  const [plan, setPlan] = useState<{ key: string; value: SkillQuarantinePreview } | null>(null);
  const [consent, setConsent] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ key: string; operation: Operation } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [, changed] = useState(0);
  const preview = key && plan?.key === key ? plan.value : null;
  const acknowledged = preview !== null && consent === preview.id;
  const busy = key && progress?.key === key ? progress.operation : null;
  const pendingWrites = unresolvedQuarantine(requestLocal);
  const needsRecheck = Boolean(selection && pendingWrites.has(selection) && busy !== 'apply');
  const latest = useRef({ preview, acknowledged, disabled, onCompleted, onRechecked });
  latest.current = { preview, acknowledged, disabled, onCompleted, onRechecked };
  const clearPlan = useCallback(() => {
    latest.current.preview = null;
    latest.current.acknowledged = false;
    setPlan(null);
    setConsent(null);
  }, []);
  const begin = useCallback(
    (operation: Operation) => {
      if (
        !mounted.current ||
        !key ||
        current.current !== key ||
        active.current ||
        latest.current.disabled
      )
        return null;
      const controller = new AbortController();
      const pending: Pending = { key, operation, controller, timer: undefined! };
      const accepts = () =>
        mounted.current && current.current === key && active.current === pending;
      pending.timer = setTimeout(() => {
        if (!accepts()) return;
        controller.abort();
        active.current = null;
        setProgress(null);
        clearPlan();
        setFailure({
          key,
          message:
            operation === 'apply'
              ? 'Completion is unknown. Recheck retained folders before another action.'
              : operation === 'recheck'
                ? 'Folders could not be rechecked before the deadline.'
                : 'Preview timed out. Prepare it again.',
        });
      }, 35_000);
      active.current = pending;
      setProgress({ key, operation });
      setFailure(null);
      return {
        pending,
        accepts,
        valid: () => accepts() && !controller.signal.aborted,
        finish: () => {
          clearTimeout(pending.timer);
          if (active.current === pending) {
            active.current = null;
            setProgress(null);
          }
        },
      };
    },
    [key, clearPlan],
  );
  useEffect(() => {
    mounted.current = true;
    clearPlan();
    setFailure(null);
    setProgress(null);
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
    if (!preview || !key) return;
    const timer = setTimeout(
      () => {
        if (current.current !== key || latest.current.preview !== preview) return;
        clearPlan();
        setFailure({ key, message: 'Preview expired. Prepare it again.' });
      },
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [key, preview, clearPlan]);
  const prepare = async () => {
    if (!key || !selection || pendingWrites.has(selection)) return;
    const run = begin('preview');
    if (!run) return;
    clearPlan();
    try {
      const input =
        action === 'quarantine'
          ? { action, id: artifact.id, expectedSha256: artifact.sha256 }
          : { action, recordId };
      const value = await requestLocal(
        '/api/quarantine/preview',
        input,
        run.pending.controller.signal,
      );
      if (!run.valid()) return;
      if (
        !validateSkillQuarantinePreview(value) ||
        !quarantinePreviewMatches(value, action, artifact, workspaceId, recordId) ||
        Date.parse(value.expiresAt) <= Date.now()
      )
        throw new Error();
      setPlan({ key, value });
    } catch {
      if (run.accepts())
        setFailure({
          key,
          message:
            'This preview could not be verified. Refresh inventory or recheck retained folders.',
        });
    } finally {
      run.finish();
    }
  };
  const acknowledge = (value: boolean) => {
    if (
      !mounted.current ||
      !key ||
      current.current !== key ||
      active.current ||
      latest.current.disabled ||
      !preview ||
      latest.current.preview !== preview ||
      Date.parse(preview.expiresAt) <= Date.now()
    )
      return;
    latest.current.acknowledged = value;
    setConsent(value ? preview.id : null);
  };
  const apply = async () => {
    if (
      !key ||
      !selection ||
      !preview ||
      latest.current.preview !== preview ||
      !latest.current.acknowledged ||
      pendingWrites.has(selection) ||
      Date.parse(preview.expiresAt) <= Date.now()
    )
      return;
    if (pendingWrites.size >= 64) {
      setFailure({ key, message: 'Earlier file moves need rechecking before another action.' });
      return;
    }
    const run = begin('apply');
    if (!run) return;
    noteQuarantineWrite(requestLocal, {
      action,
      artifact,
      workspaceId,
      recordId: preview.recordId,
      startedAt: new Date().toISOString(),
    });
    changed((value) => value + 1);
    clearPlan();
    try {
      const value = await requestLocal(
        '/api/quarantine/apply',
        { previewId: preview.id, confirm: true, acknowledgeSessionLimits: true },
        run.pending.controller.signal,
      );
      if (!run.valid()) return;
      if (!validateSkillQuarantineReceipt(value) || !quarantineReceiptMatches(value, preview))
        throw new Error();
      pendingWrites.delete(selection);
      changed((value) => value + 1);
      run.finish();
      latest.current.onCompleted(value);
    } catch {
      if (run.accepts())
        setFailure({
          key,
          message: 'Completion is unknown. Recheck retained folders before another action.',
        });
    } finally {
      run.finish();
    }
  };
  const recheck = async () => {
    if (!key || !selection) return;
    const run = begin('recheck');
    if (!run) return;
    clearPlan();
    try {
      const value = await requestLocal('/api/quarantine', undefined, run.pending.controller.signal);
      if (!run.valid()) return;
      if (!validateSkillQuarantine(value) || value.workspaceId !== workspaceId || !value.available)
        throw new Error();
      confirmQuarantineRecheck(requestLocal, value);
      changed((value) => value + 1);
      if (pendingWrites.has(selection)) throw new Error();
      run.finish();
      latest.current.onRechecked?.();
    } catch {
      if (run.accepts())
        setFailure({
          key,
          message:
            'Retained folders could not be verified. Recheck quarantine history before another action.',
        });
    } finally {
      run.finish();
    }
  };
  return {
    preview,
    acknowledged,
    busy,
    needsRecheck,
    error: key && failure?.key === key ? failure.message : null,
    prepare,
    acknowledge,
    apply,
    recheck,
    cancel: clearPlan,
  };
}
