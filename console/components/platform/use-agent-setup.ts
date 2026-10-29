'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import { validateAgentStatus } from '@/lib/agent-status';
import type { SetupAgent, SetupScope } from '@/lib/agent-setup';
import {
  validateSetupState,
  validateSetupPreview,
  validateSetupResult,
  type SetupState,
  type SetupPreview,
  type SetupResult,
} from '@/lib/agent-setup';
import {
  agentSetupKey,
  setupApplyInput,
  setupPreviewMatches,
  setupReceiptMatches,
  emptySetupAcknowledgements,
  type SetupAcknowledgements,
} from '@/lib/agent-setup-binding';

type Operation = 'load' | 'preview' | 'apply' | 'recheck';
interface Pending {
  key: string;
  identity: string;
  operation: Operation;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}
export function useAgentSetup({
  open,
  agent,
  scope,
  generation,
  onConfigured,
}: {
  open: boolean;
  agent: SetupAgent;
  scope: SetupScope;
  generation: number;
  onConfigured: () => void;
}) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
  const selectionKey = agentSetupKey(workspaceId, agent, scope, generation);
  const identity = selectionKey && workspaceId ? `${workspaceId}:${agent}:${scope}` : null;
  const key = open ? selectionKey : null;
  const currentKey = useRef(key);
  currentKey.current = key;
  const previousIdentity = useRef(identity);
  const changed = useRef(onConfigured);
  changed.current = onConfigured;
  const active = useRef<Pending | null>(null);
  const [stateCapture, setStateCapture] = useState<{
    key: string;
    value: SetupState;
  } | null>(null);
  const [previewCapture, setPreviewCapture] = useState<{
    key: string;
    value: SetupPreview;
  } | null>(null);
  const [receiptCapture, setReceiptCapture] = useState<{
    identity: string;
    value: SetupResult;
  } | null>(null);
  const [progress, setProgress] = useState<{ key: string; operation: Operation } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [message, setMessage] = useState<{ identity: string; value: string } | null>(null);
  const [unknown, setUnknown] = useState<Set<string>>(() => new Set());
  const [consent, setConsent] = useState<{
    previewId: string;
    values: SetupAcknowledgements;
  } | null>(null);
  const state = key && stateCapture?.key === key ? stateCapture.value : null;
  const preview = key && previewCapture?.key === key ? previewCapture.value : null;
  const canPreview = Boolean(
    state?.available &&
    state.agents.some(
      (entry) => entry.id === agent && entry.available && entry.scopes.includes(scope),
    ),
  );
  const receipt =
    key && identity && receiptCapture?.identity === identity ? receiptCapture.value : null;
  const busy = key && progress?.key === key ? progress.operation : null;
  const needsRecheck = identity !== null && unknown.has(identity);
  const acknowledged =
    preview && consent?.previewId === preview.id ? consent.values : emptySetupAcknowledgements();
  const markUnknown = useCallback((selected: string) => {
    setUnknown((before) => new Set(before).add(selected));
    setReceiptCapture((before) => (before?.identity === selected ? null : before));
  }, []);
  const begin = useCallback(
    (operation: Operation) => {
      if (!key || !identity || currentKey.current !== key || active.current) return null;
      const controller = new AbortController();
      const record: Pending = { key, identity, operation, controller, timer: undefined! };
      const accepts = () => currentKey.current === key && active.current === record;
      record.timer = setTimeout(() => {
        controller.abort();
        if (!accepts()) return;
        active.current = null;
        if (operation === 'apply') markUnknown(identity);
        setPreviewCapture(null);
        setConsent(null);
        setProgress(null);
        setFailure({
          key,
          message:
            operation === 'apply'
              ? 'Completion is unknown. Hooks may have changed. Recheck before another setup action.'
              : operation === 'preview'
                ? 'Preview timed out. No setup request was sent.'
                : 'Current setup support could not be read. Recheck to retry.',
        });
      }, 25_000);
      active.current = record;
      setProgress({ key, operation });
      setFailure(null);
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
    [key, identity, markUnknown],
  );
  const load = useCallback(
    async (recheck = false) => {
      const run = begin(recheck ? 'recheck' : 'load');
      if (!run || !workspaceId) return;
      setStateCapture(null);
      setPreviewCapture(null);
      setConsent(null);
      try {
        const results = await Promise.allSettled([
          requestLocal('/api/agent-setup', undefined, run.record.controller.signal),
          ...(recheck
            ? [requestLocal('/api/agents', undefined, run.record.controller.signal)]
            : []),
        ]);
        if (!run.valid()) throw new Error();
        const metadata = results[0];
        const agents = results[1];
        if (
          metadata?.status !== 'fulfilled' ||
          !validateSetupState(metadata.value) ||
          metadata.value.workspaceId !== workspaceId ||
          (recheck && (agents?.status !== 'fulfilled' || !validateAgentStatus(agents.value)))
        )
          throw new Error();
        setStateCapture({ key: run.record.key, value: metadata.value });
        if (recheck) {
          setUnknown((before) => {
            const next = new Set(before);
            next.delete(run.record.identity);
            return next;
          });
          setMessage({
            identity: run.record.identity,
            value: metadata.value.available
              ? 'Current configuration reread. Prepare a fresh setup preview.'
              : 'Current configuration reread. Setup is unavailable in this context.',
          });
          run.finish();
          changed.current();
        }
      } catch {
        if (run.accepts())
          setFailure({
            key: run.record.key,
            message: recheck
              ? 'Current configuration could not be rechecked. No completion claim is available.'
              : 'Local setup support could not be read. Recheck to retry.',
          });
      } finally {
        run.finish();
      }
    },
    [begin, workspaceId, requestLocal],
  );
  useEffect(() => {
    setPreviewCapture(null);
    setConsent(null);
    setFailure(null);
    if (!open || previousIdentity.current !== identity) {
      setReceiptCapture(null);
      setMessage(null);
    }
    previousIdentity.current = identity;
    if (key) void load();
    return () => {
      const pending = active.current;
      if (pending?.operation === 'apply') markUnknown(pending.identity);
      pending?.controller.abort();
      if (pending) clearTimeout(pending.timer);
      active.current = null;
    };
  }, [key, load, markUnknown, open, identity]);
  const acknowledge = (flag: keyof SetupAcknowledgements, value: boolean) => {
    if (!preview || busy === 'apply') return;
    setConsent({ previewId: preview.id, values: { ...acknowledged, [flag]: value } });
  };
  const prepare = async () => {
    if (!canPreview || !workspaceId || needsRecheck) return;
    const run = begin('preview');
    if (!run) return;
    setPreviewCapture(null);
    setConsent(null);
    setReceiptCapture(null);
    setMessage(null);
    try {
      const value = await requestLocal(
        '/api/agent-setup/preview',
        { agent, scope },
        run.record.controller.signal,
      );
      if (!run.valid()) throw new Error();
      if (
        !validateSetupPreview(value) ||
        !setupPreviewMatches(value, { workspaceId, agent, scope }) ||
        Date.now() >= Date.parse(value.expiresAt)
      )
        throw new Error();
      setPreviewCapture({ key: run.record.key, value });
    } catch {
      if (run.accepts())
        setFailure({
          key: run.record.key,
          message: 'This exact source could not be previewed safely. No setup request was sent.',
        });
    } finally {
      run.finish();
    }
  };
  const apply = async () => {
    if (
      !preview ||
      !workspaceId ||
      needsRecheck ||
      !setupPreviewMatches(preview, { workspaceId, agent, scope })
    )
      return;
    if (Date.now() >= Date.parse(preview.expiresAt) && key) {
      setPreviewCapture(null);
      setConsent(null);
      setFailure({
        key,
        message: 'This preview expired. Recheck and prepare a fresh setup preview.',
      });
      return;
    }
    const input = setupApplyInput(preview, acknowledged);
    if (!input) return;
    const run = begin('apply');
    if (!run) return;
    try {
      const value = await requestLocal(
        '/api/agent-setup/apply',
        input,
        run.record.controller.signal,
      );
      if (!run.valid()) throw new Error();
      if (!validateSetupResult(value) || !setupReceiptMatches(value, preview)) throw new Error();
      setPreviewCapture(null);
      setConsent(null);
      setReceiptCapture({ identity: run.record.identity, value });
      run.finish();
      changed.current();
    } catch {
      if (run.accepts()) {
        markUnknown(run.record.identity);
        setPreviewCapture(null);
        setConsent(null);
        setFailure({
          key: run.record.key,
          message:
            'Completion is unknown. Hooks may have changed. Recheck before another setup action.',
        });
      }
    } finally {
      run.finish();
    }
  };
  return {
    localAccess,
    workspaceId,
    identity,
    state,
    preview,
    result: receipt,
    canPreview,
    busy,
    needsRecheck,
    acknowledged,
    acknowledge,
    error: key && failure?.key === key ? failure.message : null,
    message: key && identity && message?.identity === identity ? message.value : null,
    prepare,
    apply,
    recheck: () => load(true),
  };
}
