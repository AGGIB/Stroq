'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  validateMcpGovernanceState,
  validateMcpGovernanceCapture,
  validateMcpGovernanceRecord,
  validateMcpGovernanceRecheck,
  type McpGovernanceState,
  type McpGovernanceCapture,
  type McpGovernancePreview,
  type McpGovernanceRecord,
  type McpGovernanceReceipt,
  type McpGovernanceRecheck,
  type McpGovernanceSelection,
} from '@/lib/mcp-governance';
import {
  mcpGovernancePending,
  subscribeMcpGovernancePending,
  notifyMcpGovernancePending,
  governanceOperationKey,
  governancePreviewMatches,
  governanceBindingMatches,
  governanceApplyInput,
  governanceCompletionMatches,
  reconcileMcpGovernance,
  emptyGovernanceAck,
  GOVERNANCE_PENDING_LIMIT,
  type McpGovernanceAcknowledgements,
} from '@/lib/mcp-governance-client';
import { useMcpGovernanceSession } from './use-mcp-governance-session';
function invalidateCurrent(value: McpGovernanceState): McpGovernanceState {
  return {
    ...value,
    current: { policyVersion: null, gate: 'unavailable', allowed: [] },
    editable: false,
    records: value.records.map((r) => ({ ...r, current: 'unavailable' })),
  };
}
function retainOperations(
  value: McpGovernanceState,
  before: McpGovernanceState | null,
): McpGovernanceState {
  if (!before || before.contextId !== value.contextId || before.workspaceId !== value.workspaceId)
    return value;
  return {
    ...value,
    records: [
      ...value.records,
      ...before.records
        .filter((r) => !value.records.some((n) => n.id === r.id && n.operationId === r.operationId))
        .map((r) => ({ ...r, current: 'unavailable' as const })),
    ],
  };
}
export function useMcpGovernance(open: boolean) {
  const session = useMcpGovernanceSession(open),
    { key, requestLocal, begin, fail } = session;
  const [saved, setSaved] = useState<{ key: string; value: McpGovernanceState } | null>(null),
    [captured, setCaptured] = useState<{ key: string; value: McpGovernanceCapture } | null>(null),
    [planned, setPlanned] = useState<{ key: string; value: McpGovernancePreview } | null>(null),
    [selection, setSelection] = useState<{
      captureId: string;
      rows: McpGovernanceSelection[];
    } | null>(null),
    [consent, setConsent] = useState<{ id: string; value: McpGovernanceAcknowledgements } | null>(
      null,
    ),
    [completed, setCompleted] = useState<{
      key: string;
      value: McpGovernanceReceipt | McpGovernanceRecheck;
    } | null>(null);
  const [, changed] = useState(0);
  const reviewedPending = useRef<string | null>(null);
  const pendingSignature = () =>
    [...mcpGovernancePending(requestLocal).entries()]
      .map(([k, v]) => `${k}:${v.preview.candidateRawSha256}:${v.startedAt}`)
      .sort()
      .join('|');
  const state = key && saved?.key === key ? saved.value : null,
    capture = key && captured?.key === key ? captured.value : null,
    preview = key && planned?.key === key ? planned.value : null,
    completion = key && completed?.key === key ? completed.value : null,
    selected = capture && selection?.captureId === capture.captureId ? selection.rows : [],
    ack = preview && consent?.id === preview.id ? consent.value : emptyGovernanceAck();
  const latest = useRef({ state, capture, preview, selected, ack });
  latest.current = { state, capture, preview, selected, ack };
  const clearPreview = useCallback(() => {
    latest.current.preview = null;
    latest.current.ack = emptyGovernanceAck();
    reviewedPending.current = null;
    setPlanned(null);
    setConsent(null);
  }, []);
  useEffect(
    () => subscribeMcpGovernancePending(requestLocal, () => changed((n) => n + 1)),
    [requestLocal],
  );
  useEffect(() => {
    clearPreview();
  }, [key, clearPreview]);
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(
      () => {
        clearPreview();
        fail('Preview expired. Prepare a new review.');
      },
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [preview, key, clearPreview, fail]);
  const refresh = useCallback(async () => {
    const run = begin('load');
    if (!run || !key) return;
    clearPreview();
    setSaved((before) =>
      before?.key === key ? { key, value: invalidateCurrent(before.value) } : null,
    );
    setCaptured(null);
    setSelection(null);
    try {
      const value = await requestLocal('/api/mcp-governance', undefined, run.signal);
      if (!run.accepts()) return;
      if (!validateMcpGovernanceState(value) || value.workspaceId !== session.workspaceId)
        throw Error();
      setSaved((before) => ({
        key,
        value: retainOperations(value, before?.key === key ? before.value : null),
      }));
    } catch (error) {
      if (run.accepts()) fail('The policy and saved operations could not be read.', error);
    } finally {
      run.finish();
    }
  }, [begin, key, requestLocal, clearPreview, fail]);
  const readRef = useRef(refresh);
  readRef.current = refresh;
  useEffect(() => {
    if (key) void readRef.current();
  }, [key]);
  const inspect = useCallback(async () => {
    const run = begin('capture');
    if (!run || !key) return;
    clearPreview();
    setCaptured(null);
    setSelection(null);
    setCompleted(null);
    try {
      const value = await requestLocal('/api/mcp-governance/capture', {}, run.signal);
      if (!run.accepts()) return;
      if (
        !validateMcpGovernanceCapture(value) ||
        (value.binding &&
          (value.binding.workspaceId !== session.workspaceId ||
            (latest.current.state?.contextId &&
              value.binding.contextId !== latest.current.state.contextId)))
      )
        throw Error();
      setCaptured({ key, value });
      if (value.captureId)
        setSelection({
          captureId: value.captureId,
          rows: value.choices
            .filter((c) => c.inAllowSet && c.eligibility === 'eligible' && c.pair)
            .map(({ id, expectedSha256 }) => ({ id, expectedSha256 })),
        });
      return value;
    } catch (error) {
      if (run.accepts()) fail('Configured MCP identities could not be inspected.', error);
    } finally {
      run.finish();
    }
  }, [begin, key, requestLocal, clearPreview, fail]);
  const selectChoice = useCallback(
    (id: string, checked: boolean) => {
      const c = latest.current.capture;
      if (!c?.captureId || session.isBusy() || !session.isCurrent()) return;
      const row = c.choices.find((v) => v.id === id && v.eligibility === 'eligible' && v.pair);
      if (!row) return;
      const before = latest.current.selected,
        rows = checked
          ? [...before.filter((v) => v.id !== id), { id, expectedSha256: row.expectedSha256 }]
          : before.filter((v) => v.id !== id);
      if (rows.length > 64) return;
      latest.current.selected = rows;
      clearPreview();
      setSelection({ captureId: c.captureId, rows });
    },
    [key, clearPreview],
  );
  const prepareSelection = useCallback(
    async (c: McpGovernanceCapture | null, rows: McpGovernanceSelection[]) => {
      const s = latest.current.state;
      if (
        !c?.canPreview ||
        !c.captureId ||
        !c.binding ||
        !s?.editable ||
        s.contextId !== c.binding.contextId
      )
        return;
      const run = begin('preview');
      if (!run || !key) return;
      clearPreview();
      setCompleted(null);
      const request = {
        captureId: c.captureId,
        binding: c.binding,
        selected: [...rows].sort((a, b) => a.id.localeCompare(b.id)),
      };
      try {
        const value = await requestLocal('/api/mcp-governance/preview', request, run.signal);
        if (!run.accepts()) return;
        if (
          !governancePreviewMatches(value, request, c) ||
          mcpGovernancePending(requestLocal).has(
            governanceOperationKey(value.binding.contextId, value.operationId),
          )
        )
          throw Error();
        setPlanned({ key, value });
        setConsent({ id: value.id, value: emptyGovernanceAck() });
      } catch (error) {
        if (run.accepts()) fail('This exact MCP policy replacement could not be previewed.', error);
      } finally {
        run.finish();
      }
    },
    [begin, key, requestLocal, clearPreview, fail],
  );
  const prepare = useCallback(
    () => prepareSelection(latest.current.capture, latest.current.selected),
    [prepareSelection],
  );
  const prepareDenyAll = useCallback(async () => {
    const capture = await inspect();
    if (
      !capture ||
      !session.isCurrent() ||
      (capture.current.gate === 'enforced' && capture.current.allowed.length === 0)
    )
      return;
    await prepareSelection(capture, []);
  }, [inspect, prepareSelection, key]);
  const acknowledge = useCallback(
    (field: keyof McpGovernanceAcknowledgements, value: boolean) => {
      const p = latest.current.preview;
      if (!p || !session.isCurrent()) return;
      if (field === 'pendingReview') reviewedPending.current = value ? pendingSignature() : null;
      const next = { ...latest.current.ack, [field]: value };
      latest.current.ack = next;
      setConsent({ id: p.id, value: next });
    },
    [key],
  );
  const accept = useCallback(
    (value: McpGovernanceReceipt | McpGovernanceRecheck) => {
      if (!key) return;
      setCompleted({ key, value });
      setSaved((before) =>
        before?.key === key && before.value.contextId === value.binding.contextId
          ? {
              key,
              value: {
                ...invalidateCurrent(before.value),
                records: [
                  { ...value.record, current: 'unavailable' },
                  ...before.value.records
                    .filter((r) => r.id !== value.record.id)
                    .map((r) => ({ ...r, current: 'unavailable' as const })),
                ],
              },
            }
          : before,
      );
      reconcileMcpGovernance(requestLocal, value);
      if (value.record.status === 'unknown')
        fail('Completion remains unknown. Recheck this exact operation.');
    },
    [key, requestLocal, fail],
  );
  const apply = useCallback(async () => {
    const p = latest.current.preview,
      body = p ? governanceApplyInput(p, latest.current.ack) : null;
    if (
      !p ||
      !body ||
      (mcpGovernancePending(requestLocal).size > 0 &&
        (!latest.current.ack.pendingReview || reviewedPending.current !== pendingSignature())) ||
      mcpGovernancePending(requestLocal).size >= GOVERNANCE_PENDING_LIMIT
    )
      return;
    const run = begin('apply');
    if (!run || !key) return;
    mcpGovernancePending(requestLocal).set(
      governanceOperationKey(p.binding.contextId, p.operationId),
      { preview: p, startedAt: new Date().toISOString() },
    );
    notifyMcpGovernancePending(requestLocal);
    clearPreview();
    setCaptured(null);
    setSelection(null);
    let received = false;
    try {
      const value = await requestLocal('/api/mcp-governance/apply', body, run.signal);
      if (!run.accepts()) return;
      if (!governanceCompletionMatches(value, p)) throw Error();
      accept(value);
      received = true;
    } catch {
      if (run.accepts())
        fail('Completion is unknown. Recheck the exact operation; do not repeat it.');
    } finally {
      run.finish();
    }
    if (received && session.isCurrent()) await refresh();
  }, [begin, key, requestLocal, clearPreview, fail, accept, refresh]);
  const recheck = useCallback(
    async (record: McpGovernanceRecord) => {
      if (
        !validateMcpGovernanceRecord(record) ||
        record.binding.contextId !== latest.current.state?.contextId
      )
        return;
      const old = mcpGovernancePending(requestLocal).get(
        governanceOperationKey(record.binding.contextId, record.operationId),
      );
      const run = begin('recheck');
      if (!run || !key) return;
      clearPreview();
      let received = false;
      try {
        const value = await requestLocal(
          '/api/mcp-governance/recheck',
          {
            contextId: record.binding.contextId,
            recordId: record.id,
            recordRevision: record.revision,
            operationId: record.operationId,
          },
          run.signal,
        );
        if (!run.accepts()) return;
        if (
          !validateMcpGovernanceRecheck(value) ||
          value.record.id !== record.id ||
          value.operationId !== record.operationId ||
          !governanceBindingMatches(value.binding, record.binding) ||
          value.record.candidateRawSha256 !== record.candidateRawSha256 ||
          value.record.candidateFingerprint !== record.candidateFingerprint ||
          (old && !governanceCompletionMatches(value, old.preview, true))
        )
          throw Error();
        accept(value);
        received = true;
      } catch (error) {
        if (run.accepts()) fail('The exact saved operation could not be rechecked.', error);
      } finally {
        run.finish();
      }
      if (received && session.isCurrent()) await refresh();
    },
    [begin, key, requestLocal, clearPreview, fail, accept, refresh],
  );
  return {
    state,
    capture,
    preview,
    selected,
    ack,
    completion,
    receipt: completion && 'previewId' in completion ? completion : null,
    pending: [...mcpGovernancePending(requestLocal).values()],
    busy: session.busy,
    error: session.error,
    connected: session.key !== null,
    workspaceId: session.workspaceId,
    refresh,
    inspect,
    selectChoice,
    prepare,
    prepareDenyAll,
    acknowledge,
    apply,
    recheck,
    clearPreview,
    close: () => {
      clearPreview();
      session.cancel();
    },
    canPrepare: !!state?.editable && !!capture?.canPreview && !session.isBusy(),
    canApply:
      !!preview &&
      !!governanceApplyInput(preview, ack) &&
      (mcpGovernancePending(requestLocal).size === 0 ||
        (ack.pendingReview && reviewedPending.current === pendingSignature())) &&
      !session.isBusy() &&
      mcpGovernancePending(requestLocal).size < GOVERNANCE_PENDING_LIMIT,
  };
}
export type McpGovernanceAction = ReturnType<typeof useMcpGovernance>;
