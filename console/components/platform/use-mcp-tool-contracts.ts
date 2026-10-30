'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import {
  validateMcpToolContractState,
  validateMcpToolContractPreview,
  validateMcpToolContractReceipt,
  type McpToolContractState,
  type McpToolContractPreview,
  type McpToolContractReceipt,
} from '@/lib/mcp-tool-contracts';
import { mcpToolContractError as safeError } from '@/lib/mcp-tool-contract-errors';
import {
  mcpToolContractDecisionInput,
  mcpToolContractPreviewMatches,
  mcpToolContractReceiptMatches,
  mcpToolContractApplyInput,
} from '@/lib/mcp-tool-contract-binding';
import {
  mcpToolContractReadAllowed,
  type McpToolContractSelection,
} from '@/lib/mcp-tool-contract-navigation';
type Operation = 'load' | 'preview' | 'apply';
type Affected = { bindingId: string; toolId: string; sha256: string };
type Pending = {
  key: string;
  operation: Operation;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
};
export function useMcpToolContracts(selection: McpToolContractSelection) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
  const allowed = mcpToolContractReadAllowed(selection, workspaceId);
  const selectedKey = allowed
    ? JSON.stringify([
        workspaceId,
        selection.registrationId,
        selection.bindingId,
        selection.toolId,
        selection.contractSha256,
      ])
    : null;
  const identity = useRef({ selectedKey, requestLocal, context: localContext, generation: 0 });
  if (
    identity.current.selectedKey !== selectedKey ||
    identity.current.requestLocal !== requestLocal ||
    identity.current.context !== localContext
  )
    identity.current = {
      selectedKey,
      requestLocal,
      context: localContext,
      generation: identity.current.generation + 1,
    };
  const [revision, setRevision] = useState(0);
  const routeKey = selectedKey ? `${selectedKey}:${identity.current.generation}` : null;
  const key = routeKey ? `${routeKey}:${revision}` : null;
  const current = useRef(key),
    mounted = useRef(false),
    active = useRef<Pending | null>(null),
    explicitRecheck = useRef<string | null>(null);
  current.current = key;
  const uncertain = useRef(new Map<string, Affected>()),
    [unknown, setUnknown] = useState(new Set<string>());
  const [capture, setCapture] = useState<{ key: string; state: McpToolContractState } | null>(null);
  const [plan, setPlan] = useState<{ key: string; preview: McpToolContractPreview } | null>(null);
  const [consent, setConsent] = useState<{
    id: string;
    contract: boolean;
    callLimits: boolean;
  } | null>(null);
  const [completed, setCompleted] = useState<{
    routeKey: string;
    receipt: McpToolContractReceipt;
  } | null>(null);
  const [progress, setProgress] = useState<{ key: string; operation: Operation } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const state = key && capture?.key === key ? capture.state : null;
  const source = selection.registrationId
    ? (state?.registrations.find((row) => row.id === selection.registrationId) ?? null)
    : null;
  const bindingMismatch = source !== null && source.bindingId !== selection.bindingId;
  const registration = bindingMismatch ? null : source;
  const sourceTool = selection.toolId
    ? (registration?.tools.find((row) => row.id === selection.toolId) ?? null)
    : null;
  const versionMismatch = sourceTool !== null && sourceTool.sha256 !== selection.contractSha256;
  const tool = versionMismatch ? null : sourceTool;
  const preview = key && plan?.key === key ? plan.preview : null;
  const ack =
    preview && consent?.id === preview.id ? consent : { contract: false, callLimits: false };
  const receipt = completed?.routeKey === routeKey ? completed.receipt : null;
  const busy = key && progress?.key === key ? progress.operation : null;
  const needsRecheck = workspaceId !== null && unknown.has(workspaceId) && busy !== 'apply';
  const affected = workspaceId ? (uncertain.current.get(workspaceId) ?? null) : null;
  const latest = useRef({ state, registration, tool, preview, ack });
  latest.current = { state, registration, tool, preview, ack };
  const clearPlan = useCallback(() => {
    latest.current.preview = null;
    setPlan(null);
    setConsent(null);
  }, []);
  const begin = useCallback(
    (operation: Operation) => {
      if (!mounted.current || !key || current.current !== key || active.current) return null;
      const controller = new AbortController(),
        record: Pending = { key, operation, controller, timer: undefined! };
      const accepts = () => mounted.current && current.current === key && active.current === record;
      record.timer = setTimeout(
        () => {
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
                ? 'Decision completion is unknown. Recheck this exact tool before another action.'
                : operation === 'preview'
                  ? 'Preview timed out. No decision was requested.'
                  : 'Recorded contracts could not be read before the deadline.',
          });
        },
        operation === 'apply' ? 35_000 : 25_000,
      );
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
    [key, clearPlan],
  );
  useEffect(() => {
    setCompleted(null);
  }, [routeKey]);
  useEffect(() => {
    mounted.current = true;
    current.current = key;
    setCapture(null);
    clearPlan();
    setFailure(null);
    if (!key || !workspaceId) return;
    const run = begin('load');
    if (!run) return;
    const recheck = explicitRecheck.current === routeKey;
    explicitRecheck.current = null;
    void requestLocal('/api/mcp-tool-contracts', undefined, run.record.controller.signal)
      .then((value) => {
        if (!run.valid()) return;
        if (!validateMcpToolContractState(value) || value.workspaceId !== workspaceId)
          throw new Error();
        setCapture({ key, state: value });
        const unresolved = uncertain.current.get(workspaceId);
        const exact =
          unresolved &&
          selection.bindingId === unresolved.bindingId &&
          selection.toolId === unresolved.toolId &&
          selection.contractSha256 === unresolved.sha256 &&
          value.available &&
          value.registrations.some(
            (row) =>
              row.id === selection.registrationId &&
              row.bindingId === unresolved.bindingId &&
              row.status === 'complete' &&
              row.tools.some(
                (candidate) =>
                  candidate.id === unresolved.toolId && candidate.sha256 === unresolved.sha256,
              ),
          );
        if (recheck && exact) {
          uncertain.current.delete(workspaceId);
          setUnknown(new Set(uncertain.current.keys()));
        }
      })
      .catch((error) => {
        if (run.accepts())
          setFailure({
            key,
            message: safeError(
              error,
              'Recorded tool contracts could not be verified. No approval state is inferred.',
            ),
          });
      })
      .finally(run.finish);
    return () => {
      mounted.current = false;
      if (current.current === key) current.current = null;
      const pending = active.current;
      if (pending) {
        pending.controller.abort();
        clearTimeout(pending.timer);
      }
      active.current = null;
    };
  }, [key, workspaceId, requestLocal, begin, clearPlan]);
  useEffect(() => {
    if (!key || !preview) return;
    const timer = setTimeout(
      () => {
        if (current.current === key && latest.current.preview?.id === preview.id) {
          clearPlan();
          setFailure({
            key,
            message: 'Preview expired. Review a fresh exact version before deciding.',
          });
        }
      },
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [key, preview, clearPlan]);
  const refresh = () => {
    if (
      !mounted.current ||
      !key ||
      current.current !== key ||
      active.current?.operation === 'apply'
    )
      return;
    const pending = active.current;
    if (pending) {
      pending.controller.abort();
      clearTimeout(pending.timer);
    }
    active.current = null;
    clearPlan();
    current.current = null;
    explicitRecheck.current = routeKey;
    setRevision((n) => n + 1);
  };
  const prepare = async (action: 'approve' | 'revoke') => {
    if (
      !workspaceId ||
      !state?.available ||
      state !== latest.current.state ||
      !registration ||
      registration !== latest.current.registration ||
      !tool ||
      tool !== latest.current.tool ||
      uncertain.current.has(workspaceId)
    )
      return;
    const input = mcpToolContractDecisionInput(registration, tool, action);
    if (!input) return;
    const run = begin('preview');
    if (!run) return;
    clearPlan();
    try {
      const value = await requestLocal(
        '/api/mcp-tool-contracts/preview',
        input,
        run.record.controller.signal,
      );
      if (!run.valid()) return;
      if (
        !validateMcpToolContractPreview(value) ||
        !mcpToolContractPreviewMatches(value, registration, tool, action, workspaceId) ||
        Date.now() >= Date.parse(value.expiresAt)
      )
        throw new Error();
      setPlan({ key: run.record.key, preview: value });
    } catch (error) {
      if (run.accepts())
        setFailure({
          key: run.record.key,
          message: safeError(
            error,
            'This exact tool version could not be previewed. Refresh the records before trying again.',
          ),
        });
    } finally {
      run.finish();
    }
  };
  const acknowledge = (field: 'contract' | 'callLimits', value: boolean) => {
    if (
      !key ||
      current.current !== key ||
      !preview ||
      latest.current.preview !== preview ||
      active.current?.operation === 'apply'
    )
      return;
    const next = { id: preview.id, ...latest.current.ack, [field]: value };
    latest.current.ack = next;
    setConsent(next);
  };
  const apply = async () => {
    if (
      !workspaceId ||
      !preview ||
      latest.current.preview !== preview ||
      uncertain.current.has(workspaceId)
    )
      return;
    const input = mcpToolContractApplyInput(
      preview,
      latest.current.ack.contract,
      latest.current.ack.callLimits,
    );
    if (!input) return;
    const run = begin('apply');
    if (!run) return;
    uncertain.current.set(workspaceId, {
      bindingId: preview.bindingId,
      toolId: preview.toolId,
      sha256: preview.expectedContractSha256,
    });
    setUnknown(new Set(uncertain.current.keys()));
    clearPlan();
    try {
      const value = await requestLocal(
        '/api/mcp-tool-contracts/apply',
        input,
        run.record.controller.signal,
      );
      if (!run.valid()) return;
      if (
        !validateMcpToolContractReceipt(value) ||
        !mcpToolContractReceiptMatches(value, preview) ||
        !routeKey
      )
        throw new Error();
      setCompleted({ routeKey, receipt: value });
      uncertain.current.delete(workspaceId);
      setUnknown(new Set(uncertain.current.keys()));
      run.finish();
      setRevision((n) => n + 1);
    } catch (error) {
      if (run.accepts())
        setFailure({
          key: run.record.key,
          message: safeError(
            error,
            'Decision completion could not be verified. Recheck this exact tool before another action.',
          ),
        });
    } finally {
      run.finish();
    }
  };
  const invalidate = () => {
    if (current.current !== key) return;
    current.current = null;
    const pending = active.current;
    if (pending) {
      pending.controller.abort();
      clearTimeout(pending.timer);
    }
    active.current = null;
    clearPlan();
    setCompleted(null);
    identity.current.generation += 1;
    setRevision((n) => n + 1);
  };
  return {
    workspaceId,
    localAccess,
    allowed,
    state,
    registration,
    tool,
    bindingMismatch,
    versionMismatch,
    preview,
    ack,
    receipt,
    busy,
    needsRecheck,
    affected,
    error: key && failure?.key === key ? failure.message : null,
    refresh,
    prepare,
    acknowledge,
    apply,
    invalidate,
    getEvidence: () =>
      mounted.current && current.current === key && state === latest.current.state
        ? { state, receipt }
        : null,
  };
}
