'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import {
  inventoryComparisonInput,
  inventoryComparisonKey,
  inventoryComparisonMatches,
  inventoryReviewAcknowledged,
} from '@/lib/inventory-comparison-binding';
import { validateInventoryComparison, type InventoryComparison } from '@/lib/inventory-changes';
import { validateInventory, type InventoryItem, type InventoryState } from '@/lib/inventory';

type InventoryOperation = 'load' | 'review';
interface InventoryPending {
  workspaceId: string;
  operation: InventoryOperation;
  controller: AbortController;
  generation: number;
  timer: ReturnType<typeof setTimeout>;
}
export function useInventory() {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
  const context = useRef({ workspaceId, localAccess, requestLocal });
  context.current = { workspaceId, localAccess, requestLocal };
  const [data, setData] = useState<InventoryState | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const [progress, setProgress] = useState<{
    workspaceId: string;
    operation: InventoryOperation;
  } | null>(null);
  const [failure, setFailure] = useState<{ workspaceId: string; message: string } | null>(null);
  const [unknown, setUnknown] = useState<Set<string>>(() => new Set());
  const unknownRef = useRef(unknown);
  const active = useRef<InventoryPending | null>(null);
  const generation = useRef(0);
  const markUnknown = useCallback((id: string) => {
    const next = new Set(unknownRef.current).add(id);
    unknownRef.current = next;
    setUnknown(next);
  }, []);
  const stopPending = useCallback(() => {
    const pending = active.current;
    if (pending?.operation === 'review') markUnknown(pending.workspaceId);
    pending?.controller.abort();
    if (pending) clearTimeout(pending.timer);
    active.current = null;
  }, [markUnknown]);
  const begin = useCallback(
    (operation: InventoryOperation) => {
      if (
        !workspaceId ||
        !/^workspace-[a-f0-9]{24}$/.test(workspaceId) ||
        !localAccess ||
        context.current.workspaceId !== workspaceId ||
        !context.current.localAccess ||
        context.current.requestLocal !== requestLocal ||
        active.current
      )
        return null;
      const controller = new AbortController();
      const pending: InventoryPending = {
        workspaceId,
        operation,
        controller,
        generation: ++generation.current,
        timer: undefined!,
      };
      const accepts = () =>
        active.current === pending &&
        generation.current === pending.generation &&
        context.current.workspaceId === workspaceId &&
        context.current.localAccess &&
        context.current.requestLocal === requestLocal &&
        !controller.signal.aborted;
      pending.timer = setTimeout(() => {
        if (!accepts()) return;
        active.current = null;
        controller.abort();
        if (operation === 'review') markUnknown(workspaceId);
        setProgress(null);
        setFailure({
          workspaceId,
          message:
            operation === 'review'
              ? 'Review completion is unknown. Refresh inventory before recording another review.'
              : 'Inventory read timed out. Earlier observations remain historical.',
        });
      }, 45_000);
      active.current = pending;
      setProgress({ workspaceId, operation });
      setFailure(null);
      return {
        pending,
        accepts,
        finish: () => {
          clearTimeout(pending.timer);
          if (active.current === pending) {
            active.current = null;
            setProgress(null);
          }
        },
      };
    },
    [workspaceId, localAccess, requestLocal, markUnknown],
  );
  const refresh = useCallback(async () => {
    if (
      !workspaceId ||
      context.current.workspaceId !== workspaceId ||
      context.current.requestLocal !== requestLocal ||
      !context.current.localAccess
    )
      return;
    stopPending();
    const run = begin('load');
    if (!run) return;
    try {
      const value = await requestLocal('/api/inventory', undefined, run.pending.controller.signal);
      if (!run.accepts()) return;
      if (!validateInventory(value) || value.workspace.id !== workspaceId)
        throw new Error('inventory-mismatch');
      setData(value);
      const next = new Set(unknownRef.current);
      next.delete(workspaceId);
      unknownRef.current = next;
      setUnknown(next);
    } catch {
      if (run.accepts())
        setFailure({
          workspaceId,
          message: 'Inventory could not be refreshed. Earlier observations remain historical.',
        });
    } finally {
      run.finish();
    }
  }, [workspaceId, requestLocal, begin, stopPending]);
  useEffect(() => {
    void refresh();
    return stopPending;
  }, [refresh, stopPending]);
  const review = async (item: InventoryItem) => {
    const currentItem = data?.items.find((entry) => entry.id === item.id);
    if (
      !workspaceId ||
      !data ||
      dataRef.current !== data ||
      data.workspace.id !== workspaceId ||
      !currentItem ||
      inventoryComparisonKey(currentItem, workspaceId) !==
        inventoryComparisonKey(item, workspaceId) ||
      !item.sha256 ||
      unknownRef.current.has(workspaceId)
    )
      return;
    const run = begin('review');
    if (!run) return;
    try {
      const value = await requestLocal(
        '/api/inventory/review',
        { itemId: item.id, sha256: item.sha256, expectedReviewedSha256: item.reviewedSha256 },
        run.pending.controller.signal,
      );
      if (!run.accepts()) return;
      if (!validateInventory(value) || !inventoryReviewAcknowledged(value, item, workspaceId))
        throw new Error('review-mismatch');
      setData(value);
    } catch {
      if (run.accepts()) {
        markUnknown(workspaceId);
        setFailure({
          workspaceId,
          message:
            'Review completion is unknown. Refresh inventory before recording another review.',
        });
      }
    } finally {
      run.finish();
    }
  };
  const busy = progress?.workspaceId === workspaceId ? progress.operation : null;
  return {
    localAccess,
    data: localAccess && data?.workspace.id === workspaceId ? data : null,
    loading: busy === 'load',
    reviewing: busy === 'review',
    error: localAccess && failure?.workspaceId === workspaceId ? failure.message : null,
    needsRecheck: workspaceId !== null && unknown.has(workspaceId),
    refresh,
    review,
  };
}

export function useInventoryEvidence(item: InventoryItem | null, workspaceId: string | null) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const selectionKey =
    localAccess && localContext?.workspace.id === workspaceId
      ? inventoryComparisonKey(item, workspaceId)
      : null;
  const [revision, setRevision] = useState(0);
  const key = selectionKey ? `${selectionKey}:${revision}` : null;
  const currentKey = useRef(key);
  currentKey.current = key;
  const active = useRef<{ key: string; controller: AbortController } | null>(null);
  const [result, setResult] = useState<{
    key: string;
    comparison: InventoryComparison | null;
    error: string | null;
    loading: boolean;
  } | null>(null);
  const id = item?.id,
    sha = item?.sha256,
    reviewedSha = item?.reviewedSha256,
    kind = item?.kind,
    agent = item?.agent,
    scope = item?.scope,
    skillSource = item?.skillSource;
  useEffect(() => {
    const selected =
      id && sha && reviewedSha !== undefined && kind && agent && scope
        ? { id, sha256: sha, reviewedSha256: reviewedSha, kind, agent, scope, skillSource }
        : null;
    const input = inventoryComparisonInput(selected, workspaceId);
    if (!key || !selected || !input || !workspaceId) return;
    const controller = new AbortController();
    const pending = { key, controller };
    active.current = pending;
    const accepts = () =>
      active.current === pending && currentKey.current === key && !controller.signal.aborted;
    const timer = setTimeout(() => {
      if (!accepts()) return;
      controller.abort();
      active.current = null;
      setResult({
        key,
        comparison: null,
        error: 'Comparison timed out. Refresh details to inspect this version.',
        loading: false,
      });
    }, 35_000);
    setResult({ key, comparison: null, error: null, loading: true });
    void requestLocal('/api/inventory/compare', input, controller.signal)
      .then((value) => {
        if (!accepts()) return;
        if (
          !validateInventoryComparison(value) ||
          !inventoryComparisonMatches(value, selected, workspaceId)
        )
          throw new Error('comparison-mismatch');
        setResult({ key, comparison: value, error: null, loading: false });
      })
      .catch(() => {
        if (accepts())
          setResult({
            key,
            comparison: null,
            error:
              'This comparison could not be verified. Refresh inventory if the version or review baseline changed.',
            loading: false,
          });
      })
      .finally(() => {
        clearTimeout(timer);
        if (active.current === pending) active.current = null;
      });
    return () => {
      controller.abort();
      if (active.current === pending) active.current = null;
      clearTimeout(timer);
    };
  }, [key, id, sha, reviewedSha, kind, agent, scope, skillSource, workspaceId, requestLocal]);
  const current = key && result?.key === key ? result : null;
  return {
    report: current?.comparison?.current ?? null,
    comparison: current?.comparison ?? null,
    error: current?.error ?? null,
    loading: Boolean(key && (!current || current.loading)),
    refresh: () => {
      if (currentKey.current !== key) return;
      setResult(null);
      setRevision((value) => value + 1);
    },
  };
}
