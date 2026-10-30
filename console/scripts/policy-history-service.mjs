import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { serialize } from 'node:v8';
import { resolve } from 'node:path';
import { runtimeLayout } from './runtime-layout.mjs';
import { runtimeDigest as captureRuntime } from './agent-setup-cli.mjs';
import { ENGINE_PATHS } from './control-engine.mjs';
import { createPolicyCasesStore } from './policy-cases-store.mjs';
import { runPolicyAdapter } from './policy-worker.mjs';
import {
  readPolicyState,
  samePolicyRevision,
  restorePolicyBytes,
  bytesHash,
} from './policy-files.mjs';
import { readPolicyHistory, assertPolicyHistoryEntry } from './policy-history-files.mjs';

const SHA = /^[a-f0-9]{64}$/,
  UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const digest = (v) => typeof v === 'string' && SHA.test(v),
  nullable = (v) => v === null || digest(v);
const closed = (v, keys) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Reflect.ownKeys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const STATUS = new Map([
  ['invalid-request', 400],
  ['policy-unavailable', 422],
  ['policy-invalid', 422],
  ['no-changes', 422],
  ['checks-failed', 422],
  ['stale-policy', 409],
  ['policy-history-unavailable', 503],
  ['policy-history-stale', 409],
  ['policy-backup-unavailable', 422],
  ['stale-runtime', 409],
  ['policy-restore-unknown', 422],
  ['preview-expired', 409],
  ['preview-mismatch', 409],
  ['shared-scope-ack-required', 422],
  ['reduced-protection-ack-required', 422],
  ['backup-ack-required', 422],
  ['interruption-ack-required', 422],
  ['busy', 409],
  ['backup-unavailable', 422],
  ['write-failed', 500],
  ['engine-unavailable', 503],
  ['engine-failed', 502],
  ['deadline-exceeded', 504],
  ['policy-cases-stale', 409],
  ['policy-cases-unavailable', 503],
  ['policy-cases-invalid', 503],
  ['policy-cases-busy', 409],
]);
const failure = (code) => ({
  status: STATUS.get(code) ?? 502,
  body: { error: STATUS.has(code) ? code : 'engine-failed' },
});
const success = (body) => ({ status: 200, body: structuredClone(body) });
function fail(code) {
  throw new Error(code);
}

/** Home-wide recovery selects server-retained bytes. No request may supply YAML or a path. */
export function createPolicyHistoryService(configuration = {}) {
  const options = { adapter: runPolicyAdapter, now: Date.now, ...configuration };
  const home = resolve(options.home),
    cases = options.caseStore ?? createPolicyCasesStore({ home });
  const loadSchema =
    options.loadSchema ??
    (() => import(pathToFileURL(runtimeLayout().adapter('local-api-schema.js')).href));
  const runtime = options.runtimeDigest ?? (() => captureRuntime(ENGINE_PATHS)),
    abort = new AbortController(),
    plans = new Map();
  let busy = false,
    stopped = false,
    pending = Promise.resolve(),
    memory = 0;
  function remove(id) {
    const p = plans.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    plans.delete(id);
    memory -= p.bytes;
  }
  async function context() {
    if (stopped) fail('engine-unavailable');
    let schema, sha;
    try {
      schema = await loadSchema();
      sha = await runtime();
    } catch {
      fail('engine-unavailable');
    }
    if (
      !digest(sha) ||
      ![
        'validatePolicyHistoryState',
        'validatePolicyRestorePreview',
        'validatePolicyRestoreReceipt',
        'validatePolicyCaseEvaluation',
        'validatePolicyCaseRegressions',
        'parsePolicyHistoryJson',
      ].every((k) => typeof schema[k] === 'function')
    )
      fail('engine-unavailable');
    return { schema, runtimeSha256: sha };
  }
  async function assertRuntime(sha) {
    if ((await context()).runtimeSha256 !== sha) fail('stale-runtime');
  }
  async function inspect() {
    const bound = await context(),
      history = await readPolicyHistory(home, { parseJson: bound.schema.parsePolicyHistoryJson });
    let current = null,
      inspection = null;
    try {
      current = await readPolicyState(home);
      inspection = await options.adapter('inspect', current.text, undefined, {
        signal: abort.signal,
      });
      if (!samePolicyRevision(current, await readPolicyState(home))) fail('stale-policy');
    } catch (e) {
      if (e.message === 'stale-policy') throw e;
    }
    await assertRuntime(bound.runtimeSha256);
    const currentValid =
      digest(inspection?.policyFingerprint) &&
      inspection?.check?.loaded === true &&
      inspection?.editable === true &&
      !inspection.check.findings.some((row) => row.kind === 'unknown-field');
    const body = {
      schema: 'stroq-policy-history/1',
      scope: 'stroq-home',
      runtimeSha256: bound.runtimeSha256,
      currentRawSha: current?.rawSha ?? null,
      currentPolicyFingerprint: currentValid ? inspection.policyFingerprint : null,
      currentValid,
      history: history.history,
      entries: history.entries,
      restoreAvailable:
        currentValid &&
        history.history.status !== 'unavailable' &&
        history.entries.some((e) => e.recovery !== 'unavailable'),
    };
    if (!bound.schema.validatePolicyHistoryState(body)) fail('engine-failed');
    return success(body);
  }
  async function preview(input) {
    if (
      !closed(input, ['entryId', 'recordSha256', 'expectedRawSha']) ||
      !UUID.test(input.entryId) ||
      !digest(input.recordSha256) ||
      !nullable(input.expectedRawSha)
    )
      return failure('invalid-request');
    const bound = await context(),
      current = await readPolicyState(home);
    if (current.rawSha !== input.expectedRawSha) fail('stale-policy');
    const history = await readPolicyHistory(home, {
      parseJson: bound.schema.parsePolicyHistoryJson,
    });
    if (history.history.status === 'unavailable') fail('policy-history-unavailable');
    const entry = history.captured.get(input.entryId);
    if (!entry || entry.row.recordSha256 !== input.recordSha256) fail('policy-history-stale');
    if (entry.row.recovery === 'unavailable') fail('policy-backup-unavailable');
    const candidateBytes =
      entry.row.recovery === 'backup' ? Buffer.from(entry.backupSnapshot.bytes) : null;
    const candidateRawSha = candidateBytes === null ? null : bytesHash(candidateBytes);
    if (candidateRawSha === current.rawSha) fail('no-changes');
    const candidateText =
      candidateBytes === null
        ? null
        : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(candidateBytes);
    const snapshot = await cases.capture(),
      prepared = await options.adapter(
        'restore-preview',
        current.text,
        { candidateText },
        { signal: abort.signal, cases: snapshot.records, caseRevision: snapshot.revision },
      );
    if (
      !closed(prepared, [
        'candidateText',
        'currentPolicyFingerprint',
        'candidateFingerprint',
        'settings',
        'mcpGovernance',
        'check',
        'simulation',
        'regressions',
        'interruptions',
        'interruptionsTruncated',
        'decisions',
        'blockers',
      ]) ||
      prepared.candidateText !== candidateText
    )
      fail('engine-failed');
    const { candidateText: _private, ...projection } = prepared;
    const created = options.now(),
      expires = created + 120000,
      previewId = randomUUID();
    const body = {
      ...projection,
      schema: 'stroq-policy-restore-preview/2',
      previewId,
      expiresAt: new Date(expires).toISOString(),
      entryId: entry.row.id,
      recordSha256: entry.row.recordSha256,
      runtimeSha256: bound.runtimeSha256,
      expectedRawSha: current.rawSha,
      candidateRawSha,
      target: entry.row.recovery,
      scope: 'stroq-home',
      hostEnforcement: false,
    };
    if (
      !bound.schema.validatePolicyRestorePreview(body) ||
      body.regressions.revision !== snapshot.revision ||
      !bound.schema.validatePolicyCaseEvaluation(
        {
          policyFingerprint: body.candidateFingerprint,
          total: body.regressions.total,
          passed: body.regressions.passed,
          failed: body.regressions.failed,
          results: body.regressions.results,
        },
        snapshot.records,
      )
    )
      fail('engine-failed');
    await assertPolicyHistoryEntry(entry);
    await assertRuntime(bound.runtimeSha256);
    await cases.assertSnapshot(snapshot);
    if (!samePolicyRevision(current, await readPolicyState(home))) fail('stale-policy');
    const plan = { body, current, entry, candidateBytes, snapshot, expires },
      bytes = serialize(plan).byteLength;
    if (bytes > 8 * 1024 * 1024) fail('engine-failed');
    for (const [id, p] of plans) if (p.expires <= options.now()) remove(id);
    while (plans.size >= 8 || memory + bytes > 8 * 1024 * 1024) remove(plans.keys().next().value);
    const timer = setTimeout(() => remove(previewId), 120000);
    timer.unref?.();
    plans.set(previewId, { ...plan, bytes, timer });
    memory += bytes;
    return success(body);
  }
  async function apply(input) {
    const required = [
        'previewId',
        'entryId',
        'recordSha256',
        'expectedRawSha',
        'candidateFingerprint',
      ],
      acks = [
        'acknowledgeSharedScope',
        'acknowledgeReducedProtection',
        'acknowledgeBackup',
        'acknowledgeInterruptions',
      ];
    if (
      !input ||
      !closed(input, [...required, ...acks.filter((k) => Object.hasOwn(input, k))]) ||
      !UUID.test(input.previewId) ||
      !UUID.test(input.entryId) ||
      !digest(input.recordSha256) ||
      !nullable(input.expectedRawSha) ||
      !digest(input.candidateFingerprint) ||
      acks.some((k) => input[k] !== undefined && typeof input[k] !== 'boolean')
    )
      return failure('invalid-request');
    const plan = plans.get(input.previewId);
    if (!plan || plan.expires <= options.now()) {
      remove(input.previewId);
      fail('preview-expired');
    }
    for (const field of ['entryId', 'recordSha256', 'expectedRawSha', 'candidateFingerprint'])
      if (input[field] !== plan.body[field]) fail('preview-mismatch');
    for (const [field, code] of [
      ['acknowledgeSharedScope', 'shared-scope-ack-required'],
      ['acknowledgeReducedProtection', 'reduced-protection-ack-required'],
      ['acknowledgeBackup', 'backup-ack-required'],
    ])
      if (input[field] !== true) fail(code);
    if (plan.body.simulation.newInterruptions > 0 && input.acknowledgeInterruptions !== true)
      fail('interruption-ack-required');
    if (
      plan.body.blockers.length ||
      !plan.body.check.ok ||
      !plan.body.simulation.ok ||
      plan.body.simulation.attacksPassing ||
      plan.body.simulation.notJudged ||
      plan.body.simulation.violations ||
      plan.body.regressions.failed
    )
      fail('checks-failed');
    remove(input.previewId);
    let committed = false;
    try {
      await assertRuntime(plan.body.runtimeSha256);
      await assertPolicyHistoryEntry(plan.entry);
      if (!samePolicyRevision(plan.current, await readPolicyState(home))) fail('stale-policy');
      return await cases.withSnapshotLock(plan.snapshot, async (lockedSnapshot) => {
        const assertCurrent = async () => {
          await assertRuntime(plan.body.runtimeSha256);
          await assertPolicyHistoryEntry(plan.entry);
          await cases.assertSnapshot(lockedSnapshot);
        };
        await assertCurrent();
        const receipt = await restorePolicyBytes(
          plan.current,
          plan.candidateBytes,
          plan.body.candidateFingerprint,
          options.now(),
          {
            assertCurrent,
            fault: async (stage, details) => {
              if (stage === 'after-rename') committed = true;
              await options.fault?.(stage, details);
            },
            verifySemantic: async (text, expected) => {
              const inspection = await options.adapter('inspect', text, undefined, {
                signal: abort.signal,
              });
              if (inspection?.policyFingerprint !== expected || inspection?.check?.loaded !== true)
                fail('policy-restore-unknown');
            },
          },
        );
        const body = {
          schema: 'stroq-policy-restore-receipt/1',
          restored: true,
          entryId: plan.body.entryId,
          receiptId: receipt.receiptId,
          restoredAt: receipt.appliedAt,
          target: plan.body.target,
          scope: 'stroq-home',
          hostEnforcement: false,
          policyFingerprint: receipt.policyFingerprint,
          rawSha: receipt.rawSha,
          backupId: receipt.backupId,
          runtimeSha256: plan.body.runtimeSha256,
        };
        const finalContext = await context();
        if (finalContext.runtimeSha256 !== plan.body.runtimeSha256) fail('policy-restore-unknown');
        if (!samePolicyRevision(receipt.sourceSnapshot, await readPolicyState(home)))
          fail('policy-restore-unknown');
        if (!finalContext.schema.validatePolicyRestoreReceipt(body)) fail('policy-restore-unknown');
        return success(body);
      });
    } catch (e) {
      if (committed) fail('policy-restore-unknown');
      throw e;
    }
  }
  function exclusive(action, input) {
    if (stopped) return Promise.resolve(failure('engine-unavailable'));
    if (busy) return Promise.resolve(failure('busy'));
    busy = true;
    pending = Promise.resolve()
      .then(() => action(input))
      .catch((e) => failure(e?.message))
      .finally(() => {
        busy = false;
      });
    return pending;
  }
  return {
    inspect: () => exclusive(inspect),
    preview: (input) => exclusive(preview, input),
    apply: (input) => exclusive(apply, input),
    async close() {
      stopped = true;
      abort.abort();
      await pending;
      for (const id of plans.keys()) remove(id);
    },
  };
}
