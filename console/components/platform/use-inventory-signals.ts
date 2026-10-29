'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import type { InventoryItem } from '@/lib/inventory';
import {
  inventorySignalApplyInput,
  inventorySignalPreviewInput,
  inventorySignalPreviewMatches,
  inventorySignalReceiptMatches,
  inventorySignalSelectionKey,
  inventorySignalStateMatches,
} from '@/lib/inventory-signal-binding';
import {
  validateInventorySignalReceipt,
  type InventorySignalPreview,
  type InventorySignalState,
  type SignalDecision,
  type SignalReason,
} from '@/lib/inventory-signal-decision';

type Transport = (path: string, body?: unknown, signal?: AbortSignal) => Promise<unknown>;
type Operation = 'load' | 'preview' | 'apply';
type Pending = {
  key: string;
  operation: Operation;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
};
// Uncertain writes survive closing the dialog. Connections and exact artifact revisions
// remain separate, and no uncertain entry is evicted to admit another write.
const uncertain = new WeakMap<Transport, Set<string>>();
function unresolved(transport: Transport) {
  let value = uncertain.get(transport);
  if (!value) {
    value = new Set();
    uncertain.set(transport, value);
  }
  return value;
}
export function useInventorySignals(
  item: InventoryItem | null,
  workspaceId: string | null,
  options: { onChanged?: (state: InventorySignalState) => void } = {},
) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const selection =
    localAccess && localContext?.workspace.id === workspaceId
      ? inventorySignalSelectionKey(item, workspaceId)
      : null;
  const identity = useRef({ selection, context: localContext, requestLocal, generation: 0 });
  if (
    identity.current.selection !== selection ||
    identity.current.context !== localContext ||
    identity.current.requestLocal !== requestLocal
  )
    identity.current = {
      selection,
      context: localContext,
      requestLocal,
      generation: identity.current.generation + 1,
    };
  const key = selection ? `${selection}:${identity.current.generation}` : null;
  const current = useRef(key),
    mounted = useRef(false),
    active = useRef<Pending | null>(null);
  current.current = key;
  const [capture, setCapture] = useState<{ key: string; value: InventorySignalState } | null>(null);
  const [plan, setPlan] = useState<{ key: string; value: InventorySignalPreview } | null>(null);
  const [consent, setConsent] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ key: string; operation: Operation } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [, changed] = useState(0);
  const state = key && capture?.key === key ? capture.value : null;
  const preview = key && plan?.key === key ? plan.value : null;
  const acknowledged = preview !== null && consent === preview.previewId;
  const busy = key && progress?.key === key ? progress.operation : null;
  const pendingWrites = unresolved(requestLocal);
  const needsRecheck = selection !== null && pendingWrites.has(selection) && busy !== 'apply';
  const latest = useRef({ state, preview, acknowledged, onChanged: options.onChanged });
  latest.current = { state, preview, acknowledged, onChanged: options.onChanged };
  const clearPlan = useCallback(() => {
    latest.current.preview = null;
    latest.current.acknowledged = false;
    setPlan(null);
    setConsent(null);
  }, []);
  const begin = useCallback(
    (operation: Operation) => {
      if (!mounted.current || !key || current.current !== key || active.current) return null;
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
        if (operation === 'load') setCapture(null);
        setFailure({
          key,
          message:
            operation === 'apply'
              ? 'Decision completion is unknown. Recheck the saved decision before another action.'
              : operation === 'preview'
                ? 'Preview timed out. Recheck before preparing a fresh preview.'
                : 'Signal decisions could not be read before the deadline. Recheck to retry.',
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
  // Snapshot only the source-bound identity. Baseline acknowledgement is independent.
  const itemId = item?.id,
    sha = item?.sha256,
    agent = item?.agent,
    source = item?.skillSource,
    scope = item?.scope;
  const load = useCallback(
    async (explicit = false) => {
      const run = begin('load');
      if (!run || !key || !selection || !item || !workspaceId) return;
      clearPlan();
      try {
        const value = await requestLocal(
          '/api/inventory/signals/state',
          { id: item.id, expectedSha256: item.sha256 },
          run.pending.controller.signal,
        );
        if (!run.valid()) return;
        if (!inventorySignalStateMatches(value, item, workspaceId)) throw new Error();
        setCapture({ key, value });
        if (explicit && value.store.status !== 'unavailable' && value.binding !== null) {
          pendingWrites.delete(selection);
          changed((value) => value + 1);
        }
      } catch {
        if (run.accepts()) {
          setCapture(null);
          setFailure({
            key,
            message:
              'Signal decisions could not be verified. Refresh inventory if this version changed.',
          });
        }
      } finally {
        run.finish();
      }
      // Item objects can be refreshed without changing the selected identity.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [
      begin,
      key,
      selection,
      itemId,
      sha,
      agent,
      source,
      scope,
      workspaceId,
      requestLocal,
      clearPlan,
    ],
  );
  useEffect(() => {
    mounted.current = true;
    setCapture(null);
    clearPlan();
    setFailure(null);
    if (key) void load();
    return () => {
      mounted.current = false;
      const pending = active.current;
      if (pending) {
        pending.controller.abort();
        clearTimeout(pending.timer);
      }
      active.current = null;
    };
  }, [key, load, clearPlan]);
  useEffect(() => {
    if (!key || !preview) return;
    const timer = setTimeout(
      () => {
        if (current.current !== key || latest.current.preview !== preview) return;
        clearPlan();
        setFailure({ key, message: 'Preview expired. Prepare a fresh decision preview.' });
      },
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [key, preview, clearPlan]);
  const refresh = () => {
    if (!mounted.current || !key || current.current !== key || active.current) return;
    setCapture(null);
    clearPlan();
    void load(true);
  };
  const prepare = async (decision: SignalDecision, reason: SignalReason) => {
    if (
      !key ||
      !selection ||
      !item ||
      !workspaceId ||
      !state ||
      latest.current.state !== state ||
      pendingWrites.has(selection)
    )
      return;
    const input = inventorySignalPreviewInput(state, item, workspaceId, decision, reason);
    if (!input) return;
    const run = begin('preview');
    if (!run) return;
    clearPlan();
    try {
      const value = await requestLocal(
        '/api/inventory/signals/preview',
        input,
        run.pending.controller.signal,
      );
      if (!run.valid()) return;
      if (!inventorySignalPreviewMatches(value, state, item, workspaceId, decision, reason))
        throw new Error();
      setPlan({ key, value });
    } catch {
      if (run.accepts())
        setFailure({
          key,
          message:
            'The decision preview could not be verified. Recheck the current decision before trying again.',
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
      !preview ||
      latest.current.preview !== preview ||
      Date.parse(preview.expiresAt) <= Date.now()
    )
      return;
    latest.current.acknowledged = value;
    setConsent(value ? preview.previewId : null);
  };
  const apply = async () => {
    if (
      !key ||
      !selection ||
      !item ||
      !workspaceId ||
      !preview ||
      latest.current.preview !== preview ||
      pendingWrites.has(selection)
    )
      return;
    const input = inventorySignalApplyInput(preview, latest.current.acknowledged);
    if (!input) return;
    if (pendingWrites.size >= 64) {
      setFailure({
        key,
        message: 'Earlier decision writes need rechecking before another decision can be saved.',
      });
      return;
    }
    const run = begin('apply');
    if (!run) return;
    pendingWrites.add(selection);
    changed((value) => value + 1);
    clearPlan();
    try {
      const value = await requestLocal(
        '/api/inventory/signals/apply',
        input,
        run.pending.controller.signal,
      );
      if (!run.valid()) return;
      if (
        !validateInventorySignalReceipt(value) ||
        !inventorySignalReceiptMatches(value, preview, item, workspaceId)
      )
        throw new Error();
      pendingWrites.delete(selection);
      changed((value) => value + 1);
      setCapture({ key, value: value.state });
      run.finish();
      latest.current.onChanged?.(value.state);
      return true;
    } catch {
      if (run.accepts())
        setFailure({
          key,
          message:
            'Decision completion is unknown. Recheck the saved decision before another action.',
        });
    } finally {
      run.finish();
    }
  };
  const invalidate = () => {
    if (
      !mounted.current ||
      !key ||
      current.current !== key ||
      active.current?.operation === 'apply'
    )
      return;
    const pending = active.current;
    if (pending?.operation === 'preview') {
      pending.controller.abort();
      clearTimeout(pending.timer);
      active.current = null;
      setProgress(null);
    }
    clearPlan();
  };
  return {
    state,
    preview,
    acknowledged,
    busy,
    needsRecheck,
    error: key && failure?.key === key ? failure.message : null,
    refresh,
    prepare,
    acknowledge,
    apply,
    invalidate,
  };
}
