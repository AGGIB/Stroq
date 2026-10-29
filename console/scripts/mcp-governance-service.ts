import { randomUUID } from 'node:crypto';
import { serialize } from 'node:v8';
import { isDeepStrictEqual } from 'node:util';
import { bytesHash } from './policy-files.mjs';
import * as boundary from '../lib/mcp-governance';
import { createGovernancePublication } from './mcp-governance-publication';
import {
  createGovernanceContext,
  fail,
  failure,
  success,
  publicRecord,
  unconfirmed,
  unavailableCurrent,
  digest,
} from './mcp-governance-service-support';
import { exact } from '../lib/mcp-governance-validation';

/** Fixed server context, bounded opaque choices, one-use previews, no browser YAML/path/command authority. */
export function createMcpGovernanceService(configuration: any) {
  const options = { now: Date.now, ...configuration },
    abort = new AbortController();
  const context = createGovernanceContext(options, abort.signal);
  const publication = createGovernancePublication(options, context, abort.signal);
  const captures = new Map<string, any>(),
    previews = new Map<string, any>();
  let busy = false,
    stopped = false,
    pending: Promise<any> = Promise.resolve();
  function cache(map: Map<string, any>, id: string, value: any) {
    const bytes = serialize({
      ...value,
      context: { ...value.context, store: undefined },
    }).byteLength;
    if (bytes > 8 * 1024 * 1024) fail('mcp-governance-unavailable');
    for (const [key, row] of map)
      if (row.expires <= options.now()) {
        clearTimeout(row.timer);
        map.delete(key);
      }
    let total = [...map.values()].reduce((n, row) => n + row.bytes, 0);
    while (map.size >= 8 || total + bytes > 8 * 1024 * 1024) {
      const key = map.keys().next().value!,
        row = map.get(key);
      total -= row.bytes;
      clearTimeout(row.timer);
      map.delete(key);
    }
    const expires = options.now() + 120000;
    const timer = setTimeout(() => map.delete(id), 120000);
    timer.unref?.();
    map.set(id, { ...value, bytes, expires, timer });
  }
  function take(map: Map<string, any>, id: string, consume = false) {
    const row = map.get(id);
    if (consume && row) {
      clearTimeout(row.timer);
      map.delete(id);
    }
    if (!row || row.expires <= options.now()) fail('mcp-governance-preview-expired');
    return row;
  }
  async function read() {
    try {
      const c = await context.load(),
        history = await c.store.read();
      const records = history.records
        .filter(
          (r: any) =>
            r.intent.binding.contextId === c.contextId &&
            r.intent.binding.workspaceId === options.workspaceId,
        )
        .map((r: any) => publicRecord(r, c));
      const body = {
        schema: 'stroq-mcp-governance/1',
        generatedAt: new Date(options.now()).toISOString(),
        contextId: c.contextId,
        workspaceId: options.workspaceId,
        runtimeSha256: c.runtimeSha256,
        policyRawSha256: c.policy.rawSha,
        policyFingerprint: c.inspection.policyFingerprint,
        current: c.inspection.current,
        editable: history.status !== 'unavailable',
        history: history.status,
        records,
        error: history.status === 'unavailable' ? 'mcp-governance-store-unavailable' : null,
      };
      if (!boundary.validateMcpGovernanceState(body)) fail('mcp-governance-unavailable');
      return success(body);
    } catch (error) {
      const body = {
        schema: 'stroq-mcp-governance/1',
        generatedAt: new Date(options.now()).toISOString(),
        contextId: null,
        workspaceId: options.workspaceId,
        runtimeSha256: null,
        policyRawSha256: null,
        policyFingerprint: null,
        current: unavailableCurrent(),
        editable: false,
        history: 'unavailable',
        records: [],
        error: failure(error).body.error,
      };
      return success(body);
    }
  }
  async function capture(input: unknown) {
    if (!exact(input, [])) fail('mcp-governance-invalid');
    const c = await context.load(),
      history = await c.store.read();
    if (history.status === 'unavailable') fail('mcp-governance-store-unavailable');
    const source = await context.sources(c);
    await context.assertContext(c);
    await context.assertPolicy(c);
    const id = randomUUID(),
      binding = {
        contextId: c.contextId,
        workspaceId: options.workspaceId,
        runtimeSha256: c.runtimeSha256,
        policyRawSha256: c.policy.rawSha,
        policyFingerprint: c.inspection.policyFingerprint,
        captureSha256: source.sha256,
      };
    const body = {
      schema: 'stroq-mcp-governance-capture/1',
      capturedAt: new Date(options.now()).toISOString(),
      captureId: id,
      binding,
      current: c.inspection.current,
      compatibility: { status: 'supported', format: 2, olderRuntimes: 'reject-v2' },
      choices: source.choices,
      gaps: source.gaps,
      canPreview: true,
      reason: null,
    };
    if (
      !boundary.validateMcpGovernanceCapture(body) ||
      !Array.isArray(source.privateChoices) ||
      source.privateChoices.some(
        (p: any) => !body.choices.some((q: any) => q.id === p.id && q.eligibility === 'eligible'),
      )
    )
      fail('mcp-governance-unavailable');
    cache(captures, id, { context: c, body, privateChoices: source.privateChoices });
    return success(body);
  }
  async function preview(input: unknown) {
    if (!boundary.validateMcpGovernancePreviewRequest(input)) fail('mcp-governance-invalid');
    const captured = take(captures, input.captureId);
    if (!isDeepStrictEqual(captured.body.binding, input.binding)) fail('mcp-governance-stale');
    const c = captured.context;
    await context.assertContext(c, input.binding.captureSha256);
    await context.assertPolicy(c);
    const allowed = input.selected.map((selected) => {
      const row = captured.body.choices.find(
        (q: any) =>
          q.id === selected.id &&
          q.expectedSha256 === selected.expectedSha256 &&
          q.eligibility === 'eligible',
      );
      const pair = captured.privateChoices.find((p: any) => p.id === selected.id)?.pair;
      if (!row || !pair) fail('mcp-governance-selection-unavailable');
      return pair;
    });
    const snapshot = await options.caseStore.capture();
    const prepared = await options.adapter(
      'mcp-governance-preview',
      c.policy.text,
      { allowed, runtimeSha256: c.runtimeSha256 },
      { signal: abort.signal, cases: snapshot.records, caseRevision: snapshot.revision },
    );
    const candidateBytes =
      typeof prepared.candidateText === 'string'
        ? Buffer.from(prepared.candidateText, 'utf8')
        : null;
    if (
      !candidateBytes ||
      candidateBytes.length > 256 * 1024 ||
      !digest(prepared.candidateFingerprint) ||
      prepared.currentPolicyFingerprint !== input.binding.policyFingerprint ||
      !isDeepStrictEqual(prepared.current, c.inspection.current)
    )
      fail('mcp-governance-unavailable');
    const history = await c.store.read();
    if (history.status === 'unavailable') fail('mcp-governance-store-unavailable');
    const unknown = unconfirmed(
      history.records.filter((r: any) => r.intent.binding.contextId === c.contextId),
    );
    const now = options.now();
    const body = {
      schema: 'stroq-mcp-governance-preview/1',
      id: randomUUID(),
      operationId: randomUUID(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 120000).toISOString(),
      captureId: input.captureId,
      binding: input.binding,
      selected: input.selected,
      candidateRawSha256: bytesHash(candidateBytes),
      candidateFingerprint: prepared.candidateFingerprint,
      policyVersion: 2,
      current: prepared.current,
      diff: prepared.diff,
      selectedEffect: 'continue-existing-checks',
      unlistedEffect: 'deny',
      unknownEffect: 'deny',
      registrationPinned: false,
      check: prepared.check,
      simulation: prepared.simulation,
      regressions: prepared.regressions,
      gateChecks: prepared.gateChecks,
      blockers: [
        ...(!prepared.check?.ok ? ['policy-checks-failed'] : []),
        ...(!prepared.simulation?.ok ? ['simulation-failed'] : []),
        ...(prepared.regressions?.failed ? ['saved-case-failures'] : []),
        ...(!prepared.gateChecks?.passed ? ['gate-checks-failed'] : []),
      ],
      unconfirmedRecords: unknown,
      requiresRecoveryReview: unknown.length > 0,
      requiresWeakening: prepared.requiresWeakening,
      requiresInterruptions:
        prepared.simulation?.newInterruptions > 0 ||
        prepared.diff.removed.length > 0 ||
        c.inspection.current.gate === 'absent',
      scope: 'stroq-home',
      retainsConfigurationCopies: true,
      existingProxies: 'restart-required',
      existingTasks: 'launch-policy-unchanged',
      hostEnforcement: false,
    };
    if (
      !boundary.validateMcpGovernancePreview(body) ||
      body.regressions.revision !== snapshot.revision
    )
      fail('mcp-governance-unavailable');
    await context.assertContext(c, input.binding.captureSha256);
    await context.assertPolicy(c);
    await options.caseStore.assertSnapshot(snapshot);
    cache(previews, body.id, { context: c, body, candidateBytes, snapshot });
    return success(body);
  }
  async function apply(input: any) {
    // Recognized previews are consumed even by malformed consent/replay attempts.
    const plan = take(previews, input?.previewId, true);
    if (!boundary.validateMcpGovernanceApplyRequest(input)) fail('mcp-governance-consent-required');
    if (
      input.operationId !== plan.body.operationId ||
      input.contextId !== plan.body.binding.contextId
    )
      fail('mcp-governance-stale');
    if (
      (plan.body.requiresWeakening && input.acknowledgeWeakening !== true) ||
      (plan.body.requiresInterruptions && input.acknowledgeInterruptions !== true) ||
      (plan.body.requiresRecoveryReview && input.acknowledgeUnconfirmed !== true)
    )
      fail('mcp-governance-consent-required');
    if (plan.body.blockers.length) fail('mcp-governance-checks-failed');
    await context.assertContext(plan.context, plan.body.binding.captureSha256);
    await context.assertPolicy(plan.context);
    await options.caseStore.assertSnapshot(plan.snapshot);
    return publication.apply(plan);
  }
  const wrap =
    (action: (input?: any) => Promise<any>, exclusive = false) =>
    async (input?: any) => {
      if (stopped) return failure(Error('mcp-governance-unavailable'));
      if (exclusive && busy) {
        if (action === apply) {
          try {
            take(previews, input?.previewId, true);
          } catch {
            /* Recognized attempts remain one-use. */
          }
        }
        return failure(Error('mcp-governance-busy'));
      }
      if (exclusive) busy = true;
      const operation = Promise.resolve()
        .then(() => action(input))
        .catch(failure)
        .finally(() => {
          if (exclusive) busy = false;
        });
      pending = Promise.allSettled([pending, operation]);
      return operation;
    };
  return {
    read: wrap(read),
    capture: wrap(capture, true),
    preview: wrap(preview, true),
    apply: wrap(apply, true),
    recheck: wrap(publication.recheck, true),
    close: async () => {
      stopped = true;
      abort.abort();
      await pending;
      for (const map of [captures, previews]) {
        for (const row of map.values()) clearTimeout(row.timer);
        map.clear();
      }
    },
  };
}
