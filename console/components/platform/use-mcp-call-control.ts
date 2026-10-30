'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import {
  validateMcpCallControlInspection,
  type McpCallControlAction,
  type McpCallControlInspection,
  type McpCallControlPreview,
  type McpCallControlReceipt,
  type McpCallControlRecheck,
} from '@/lib/mcp-call-controls';
import { validateMcpCallControlOverview } from '@/lib/mcp-call-control-overview';
import {
  CALL_CONTROL_PENDING_LIMIT,
  CALL_CONTROL_UNKNOWN,
  callControlPending,
  callControlPendingKey,
  classifyCallControlPending,
  callControlMessage,
  callControlTargetKey,
  callControlTargetId,
  callControlRetainedView,
  callControlCanPrepare,
  callControlPreviewMatches,
  callControlApplyInput,
  callControlReceiptMatches,
  callControlReceiptConfirmed,
  callControlRecheckCandidateMatches,
  callControlRecheckConfirmed,
  emptyCallControlAck,
  type McpCallControlTarget,
  type CallControlView,
  type CallControlAck,
  type CallControlSetupRecovery,
} from '@/lib/mcp-call-control-binding';

type Operation = 'inspect' | 'preview' | 'apply' | 'recheck';
type ViewState = {
  contextId: string | null;
  inspection: McpCallControlInspection | null;
  retained: CallControlView | null;
  preview: McpCallControlPreview | null;
  ack: CallControlAck;
  receipt: McpCallControlReceipt | null;
  rechecked: McpCallControlRecheck | null;
  busy: Operation | null;
  error: string | null;
};
const empty = (): ViewState => ({
  contextId: null,
  inspection: null,
  retained: null,
  preview: null,
  ack: emptyCallControlAck(),
  receipt: null,
  rechecked: null,
  busy: null,
  error: null,
});
export function useMcpCallControl(
  target: McpCallControlTarget | null,
  enabled = true,
  setupRecovery: CallControlSetupRecovery | null = null,
) {
  const { localAccess, localContext, requestLocal } = usePlatform(),
    workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
  const targetKey = callControlTargetKey(target);
  const selected =
    enabled && workspaceId && targetKey
      ? `${targetKey}:${setupRecovery ? JSON.stringify([setupRecovery.contextId, setupRecovery.controlId, setupRecovery.candidate]) : ''}`
      : null;
  const identity = useRef({ selected, localContext, requestLocal, generation: 0 });
  if (
    identity.current.selected !== selected ||
    identity.current.localContext !== localContext ||
    identity.current.requestLocal !== requestLocal
  )
    identity.current = {
      selected,
      localContext,
      requestLocal,
      generation: identity.current.generation + 1,
    };
  const key = selected ? `${selected}:${identity.current.generation}` : null,
    current = useRef(key),
    mounted = useRef(false);
  current.current = key;
  const [snapshot, setSnapshot] = useState<{ key: string; value: ViewState } | null>(null),
    [, changed] = useState(0);
  const state = key && snapshot?.key === key ? snapshot.value : empty(),
    latest = useRef(state);
  latest.current = state;
  const active = useRef<{
    key: string;
    operation: Operation;
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const writes = callControlPending(requestLocal),
    artifactId = callControlTargetId(target);
  const { pending, foreignPending, unscopedPending } = classifyCallControlPending(
    requestLocal,
    workspaceId,
    state.contextId,
    artifactId,
  );
  const hasPending = () =>
    [...writes.values()].some(
      (w) =>
        w.preview.workspaceId === workspaceId &&
        w.preview.artifact.id === artifactId &&
        w.preview.contextId === latest.current.contextId,
    );
  const update = useCallback(
    (value: Partial<ViewState>) => {
      if (!key || current.current !== key || !mounted.current) return;
      latest.current = { ...latest.current, ...value };
      setSnapshot({ key, value: latest.current });
    },
    [key],
  );
  const begin = useCallback(
    (operation: Operation) => {
      if (!key || !workspaceId || !mounted.current || current.current !== key || active.current)
        return null;
      const controller = new AbortController(),
        r = { key, operation, controller, timer: undefined! as ReturnType<typeof setTimeout> };
      const accepts = () => mounted.current && current.current === key && active.current === r;
      r.timer = setTimeout(
        () => {
          if (!accepts()) return;
          controller.abort();
          active.current = null;
          update({
            busy: null,
            preview: null,
            ack: emptyCallControlAck(),
            error:
              operation === 'apply'
                ? CALL_CONTROL_UNKNOWN
                : 'The local read timed out. Recheck again.',
          });
        },
        operation === 'apply' ? 60_000 : 30_000,
      );
      active.current = r;
      update({ busy: operation, error: null });
      return {
        r,
        accepts,
        valid: () => accepts() && !controller.signal.aborted,
        finish: () => {
          clearTimeout(r.timer);
          if (active.current === r) {
            active.current = null;
            update({ busy: null });
          }
        },
      };
    },
    [key, workspaceId, update],
  );
  const refresh = useCallback(async () => {
    if (!target || target.kind === 'recovery') return;
    const request = begin('inspect');
    if (!request) return;
    update({
      contextId: null,
      inspection: null,
      retained: null,
      preview: null,
      ack: emptyCallControlAck(),
    });
    try {
      if (target.kind === 'source') {
        const v = await requestLocal(
          '/api/mcp-call-controls/inspect',
          { id: target.id, expectedSha256: target.expectedSha256 },
          request.r.controller.signal,
        );
        if (!request.valid()) return;
        if (
          !validateMcpCallControlInspection(v) ||
          v.workspaceId !== workspaceId ||
          v.artifact.id !== target.id ||
          v.artifact.sha256 !== target.expectedSha256
        )
          throw Error();
        update({ contextId: v.contextId, inspection: v });
      } else {
        const v = await requestLocal(
          '/api/mcp-call-controls',
          undefined,
          request.r.controller.signal,
        );
        if (!request.valid()) return;
        if (
          !validateMcpCallControlOverview(v) ||
          v.workspaceId !== workspaceId ||
          v.contextId !== target.state.contextId
        )
          throw Error();
        const row = v.controls.find(
          (r) =>
            r.controlId === target.row.controlId &&
            r.retainedSetupId === target.row.retainedSetupId,
        );
        if (!row) throw Error();
        update({
          contextId: v.contextId,
          retained: callControlRetainedView({ kind: 'retained', state: v, row }),
        });
      }
    } catch (e) {
      if (request.accepts())
        update({
          error: callControlMessage(
            e,
            'Call-control evidence could not be verified. Refresh before changing it.',
          ),
        });
    } finally {
      request.finish();
    }
  }, [
    begin,
    requestLocal,
    workspaceId,
    target?.kind === 'source' || target?.kind === 'recovery' ? target.id : target?.row.controlId,
    target?.kind === 'source'
      ? target.expectedSha256
      : target?.kind === 'retained'
        ? target.state.contextId
        : null,
    target?.kind === 'retained' ? target.row.retainedSetupId : null,
  ]);
  useEffect(() => {
    mounted.current = true;
    latest.current = empty();
    setSnapshot(key ? { key, value: latest.current } : null);
    return () => {
      mounted.current = false;
      if (active.current) {
        active.current.controller.abort();
        clearTimeout(active.current.timer);
      }
      active.current = null;
    };
  }, [key]);
  useEffect(() => {
    if (!key) return;
    if (target?.kind === 'retained') {
      if (validateMcpCallControlOverview(target.state) && target.state.workspaceId === workspaceId)
        update({ contextId: target.state.contextId, retained: callControlRetainedView(target) });
      else update({ error: 'Retained control evidence could not be verified.' });
    } else if (target?.kind === 'recovery')
      update({
        contextId:
          target.contextId && /^context-[a-f0-9]{64}$/.test(target.contextId)
            ? target.contextId
            : null,
      });
    else void refresh();
  }, [key, refresh]);
  useEffect(() => {
    if (!key || !state.preview) return;
    const p = state.preview;
    const timer = setTimeout(
      () => {
        if (
          current.current === key &&
          latest.current.preview === p &&
          active.current?.operation !== 'apply'
        )
          update({
            preview: null,
            ack: emptyCallControlAck(),
            error: 'Preview expired. Refresh and prepare again.',
          });
      },
      Math.max(0, Date.parse(p.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [key, state.preview, update]);
  const prepare = async (action: McpCallControlAction) => {
    const view = latest.current.inspection ?? latest.current.retained;
    if (
      !target ||
      target.kind === 'recovery' ||
      !view ||
      hasPending() ||
      writes.size >= CALL_CONTROL_PENDING_LIMIT ||
      (target.kind === 'retained' && !target.row.retainedSetupId) ||
      !callControlCanPrepare(view, action, target.kind === 'retained')
    )
      return;
    const request = begin('preview');
    if (!request) return;
    update({ preview: null, ack: emptyCallControlAck(), receipt: null, rechecked: null });
    try {
      const input =
        target.kind === 'retained'
          ? {
              retainedSetupId: target.row.retainedSetupId,
              expectedContextId: view.contextId,
              action,
              expectedRevision: view.revision,
              expectedEventId: view.current?.eventId ?? null,
            }
          : {
              id: target.id,
              expectedSha256: target.expectedSha256,
              expectedContextId: view.contextId,
              action,
              expectedRevision: view.revision,
              expectedEventId: view.current?.eventId ?? null,
            };
      const value = await requestLocal(
        '/api/mcp-call-controls/preview',
        input,
        request.r.controller.signal,
      );
      if (!request.valid()) return;
      if (
        !callControlPreviewMatches(value, view, action, target.kind === 'retained') ||
        Date.parse(value.expiresAt) <= Date.now()
      )
        throw Error();
      update({ preview: value });
    } catch (e) {
      if (request.accepts())
        update({
          error: callControlMessage(
            e,
            'The preview does not match this control. Refresh and review again.',
          ),
        });
    } finally {
      request.finish();
    }
  };
  const apply = async () => {
    const p = latest.current.preview;
    if (
      !p ||
      hasPending() ||
      writes.size >= CALL_CONTROL_PENDING_LIMIT ||
      Date.parse(p.expiresAt) <= Date.now()
    )
      return null;
    const input = callControlApplyInput(p, latest.current.ack);
    if (!input) return null;
    const request = begin('apply');
    if (!request) return null;
    const startedAt = new Date().toISOString();
    const pendingKey = callControlPendingKey(p);
    writes.set(pendingKey, { preview: p, startedAt });
    changed((n) => n + 1);
    update({ preview: null, ack: emptyCallControlAck(), receipt: null, rechecked: null });
    try {
      const value = await requestLocal(
        '/api/mcp-call-controls/apply',
        input,
        request.r.controller.signal,
      );
      if (!request.valid()) return null;
      if (!callControlReceiptMatches(value, p, startedAt)) throw Error();
      if (callControlReceiptConfirmed(value)) writes.delete(pendingKey);
      update({
        receipt: value,
        inspection: null,
        retained: null,
        error: callControlReceiptConfirmed(value) ? null : CALL_CONTROL_UNKNOWN,
      });
      changed((n) => n + 1);
      return value;
    } catch (e) {
      if (request.accepts()) update({ error: callControlMessage(e, CALL_CONTROL_UNKNOWN) });
      return null;
    } finally {
      request.finish();
    }
  };
  const recheck = async (operationId: string) => {
    const entry = [...writes.entries()].find(
        ([, w]) =>
          w.preview.operationId === operationId && w.preview.contextId === latest.current.contextId,
      ),
      write = entry?.[1],
      recovery = setupRecovery?.candidate.operationId === operationId ? setupRecovery : null;
    const p =
      write?.preview ??
      (recovery
        ? {
            ...recovery.candidate,
            workspaceId: recovery.workspaceId,
            contextId: recovery.contextId,
            controlId: recovery.controlId,
            action: 'setup' as const,
            expectedEventId: null,
          }
        : null);
    if (
      !p ||
      p.workspaceId !== workspaceId ||
      p.artifact.id !== artifactId ||
      !latest.current.contextId ||
      p.contextId !== latest.current.contextId
    )
      return null;
    const request = begin('recheck');
    if (!request) return;
    const startedAt = write?.startedAt ?? new Date().toISOString();
    try {
      const value = await requestLocal(
        '/api/mcp-call-controls/recheck',
        {
          id: p.artifact.id,
          expectedSha256: p.artifact.sha256,
          expectedContextId: p.contextId,
          operationId: p.operationId,
          action: p.action,
          controlId: p.controlId,
          invocationSha256: p.invocationSha256,
          expectedEventId: p.expectedEventId,
        },
        request.r.controller.signal,
      );
      if (!request.valid()) return;
      if (!callControlRecheckCandidateMatches(value, p, startedAt)) throw Error();
      if (callControlRecheckConfirmed(value) && entry) writes.delete(entry[0]);
      update({
        rechecked: value,
        preview: null,
        ack: emptyCallControlAck(),
        inspection: null,
        retained: null,
        error: callControlRecheckConfirmed(value)
          ? null
          : value.authority === 'absent'
            ? 'No matching event at recheck. Completion remains unknown.'
            : CALL_CONTROL_UNKNOWN,
      });
      changed((n) => n + 1);
      return value;
    } catch (e) {
      if (request.accepts())
        update({
          error: callControlMessage(
            e,
            'This exact operation could not be rechecked. Its completion remains unknown.',
          ),
        });
      return null;
    } finally {
      request.finish();
    }
  };
  return {
    localAccess,
    workspaceId,
    contextId: state.contextId,
    inspection: state.inspection,
    view: state.inspection ?? state.retained,
    preview: state.preview,
    ack: state.ack,
    receipt: state.receipt,
    rechecked: state.rechecked,
    busy: state.busy,
    error: state.error,
    pending,
    foreignPending,
    unscopedPending,
    setupRecovery,
    needsRecheck: pending.length > 0,
    capacityReached: writes.size >= CALL_CONTROL_PENDING_LIMIT,
    refresh,
    canRefresh: target?.kind !== 'recovery',
    prepare,
    apply,
    recheck,
    acknowledge: (name: keyof CallControlAck, value: boolean) =>
      update({ ack: { ...latest.current.ack, [name]: value } }),
    cancel: () => {
      if (!active.current) update({ preview: null, ack: emptyCallControlAck() });
    },
  };
}
