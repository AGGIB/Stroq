import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runtimeLayout } from './runtime-layout.mjs';
import { createPolicyCasesStore } from './policy-cases-store.mjs';
import {
  applyPolicyBytes,
  readPolicyState,
  samePolicyRevision,
  MAX_POLICY_BYTES,
} from './policy-files.mjs';
import { runPolicyAdapter } from './policy-worker.mjs';

const TTL = 10 * 60_000;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9-]{36}$/;
const ERRORS = new Map([
  ['invalid-request', 400],
  ['policy-unavailable', 422],
  ['policy-invalid', 422],
  ['weakening-not-allowed', 422],
  ['no-changes', 422],
  ['stale-policy', 409],
  ['preview-expired', 409],
  ['preview-mismatch', 409],
  ['checks-failed', 422],
  ['interruption-ack-required', 422],
  ['action-scope-ack-required', 422],
  ['busy', 409],
  ['backup-unavailable', 422],
  ['engine-unavailable', 503],
  ['engine-failed', 502],
  ['deadline-exceeded', 504],
  ['write-failed', 500],
  ['policy-cases-stale', 409],
  ['policy-cases-unavailable', 503],
  ['policy-cases-invalid', 503],
  ['policy-cases-busy', 409],
]);
const TRY_KINDS = new Set(['command', 'read', 'write', 'fetch']);
// The worker checks the subject character by character; this is the parent's closed boundary.
const validTry = (value) =>
  keys(value, ['kind', 'subject']) &&
  Object.keys(value).length === 2 &&
  TRY_KINDS.has(value.kind) &&
  typeof value.subject === 'string' &&
  value.subject.trim().length > 0 &&
  value.subject.length <= 1000;
const object = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const keys = (value, allowed) =>
  object(value) && Object.keys(value).every((key) => allowed.includes(key));
const digest = (value) => typeof value === 'string' && SHA.test(value);
const rawDigest = (value) => value === null || digest(value);
const error = (code) => ({
  status: ERRORS.get(code) ?? 502,
  body: { error: ERRORS.has(code) ? code : 'engine-failed' },
});
const result = (body) => ({ status: 200, body: structuredClone(body) });
// Closed parent boundary; the policy worker independently uses core ACTION_CLASSES.
const ACTION_CLASSES = new Set([
  'shell.exec_encoded',
  'shell.network',
  'shell.destructive',
  'shell.unparsed',
  'fs.secrets',
  'fs.canary',
  'git.push_external',
  'config.self',
  'config.self_touch',
  'config.git_exec',
  'config.persistence',
  'config.instructions',
  'config.instructions_payload',
  'network.fetch',
  'mcp.call',
  'mcp.side_effect',
  'origin.untrusted',
  'origin.suspect',
  'secret.egress',
  'secret.unscannable',
]);
const actionClasses = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= ACTION_CLASSES.size &&
  new Set(value).size === value.length &&
  Array.from(value).every((item) => ACTION_CLASSES.has(item));

function validActionControl(prepared, requested) {
  const control = prepared.actionControl;
  const changes = prepared.changes?.filter((item) => item.field === 'class-deny');
  if (!Array.isArray(changes)) return false;
  if (control === null) return changes.length === 0;
  return (
    keys(control, [
      'classes',
      'removedRules',
      'narrowedRules',
      'taint',
      'scope',
      'hostEnforcement',
    ]) &&
    Object.keys(control).length === 6 &&
    actionClasses(control.classes) &&
    control.classes.every(
      (item, i) => requested?.includes(item) && (i === 0 || control.classes[i - 1] < item),
    ) &&
    [control.removedRules, control.narrowedRules].every(
      (n) => Number.isSafeInteger(n) && n >= 0 && n <= 512,
    ) &&
    control.removedRules + control.narrowedRules <= 512 &&
    control.taint === 'any' &&
    control.scope === 'stroq-home' &&
    control.hostEnforcement === false &&
    changes.length === control.classes.length &&
    changes.every(
      (item, i) =>
        keys(item, ['field', 'actionClass', 'from', 'to']) &&
        Object.keys(item).length === 4 &&
        item.actionClass === control.classes[i] &&
        item.from === 'current-policy' &&
        item.to === 'deny',
    )
  );
}

function validChanges(value) {
  return (
    keys(value, ['defaultEffect', 'threshold', 'promoteRuleIndexes', 'denyActionClasses']) &&
    Object.keys(value).length > 0 &&
    (value.defaultEffect === undefined || ['ask', 'deny'].includes(value.defaultEffect)) &&
    (value.threshold === undefined ||
      (typeof value.threshold === 'number' &&
        Number.isFinite(value.threshold) &&
        value.threshold >= 0 &&
        value.threshold <= 1)) &&
    (value.denyActionClasses === undefined || actionClasses(value.denyActionClasses)) &&
    (value.promoteRuleIndexes === undefined ||
      (Array.isArray(value.promoteRuleIndexes) &&
        value.promoteRuleIndexes.length <= 512 &&
        new Set(value.promoteRuleIndexes).size === value.promoteRuleIndexes.length &&
        value.promoteRuleIndexes.every(
          (index) => Number.isInteger(index) && index >= 0 && index < 512,
        )))
  );
}

/** This service accepts settings, never client-selected paths or YAML. Routes supply local auth/CSRF. */
export function createPolicyService({
  home,
  adapter = runPolicyAdapter,
  now = Date.now,
  caseStore = createPolicyCasesStore({ home }),
}) {
  const previews = new Map();
  let busy = false;
  let closed = false;
  let pending = Promise.resolve();
  const abort = new AbortController();
  function sweep() {
    for (const [id, value] of previews) if (value.expires <= now()) previews.delete(id);
    while (previews.size >= 8) previews.delete(previews.keys().next().value);
  }
  function exclusive(action) {
    if (closed) return Promise.resolve(error('engine-unavailable'));
    if (busy) return error('busy');
    busy = true;
    pending = Promise.resolve()
      .then(action)
      .catch((cause) => error(cause?.message))
      .finally(() => {
        busy = false;
      });
    return pending;
  }
  return {
    async inspect() {
      return exclusive(async () => {
        const current = await readPolicyState(home);
        const inspection = await adapter('inspect', current.text, undefined, {
          signal: abort.signal,
        });
        if (!samePolicyRevision(current, await readPolicyState(home))) return error('stale-policy');
        return result({
          schema: 'stroq-policy/1',
          source: current.text === null ? 'default' : 'file',
          expectedRawSha: current.rawSha,
          ...inspection,
        });
      });
    },
    /** One made-up action judged by the current policy in throwaway folders. Writes nothing. */
    async tryAction(input) {
      if (!validTry(input)) return error('invalid-request');
      return exclusive(async () => {
        const current = await readPolicyState(home);
        const judged = await adapter('try-action', current.text, input, { signal: abort.signal });
        if (!samePolicyRevision(current, await readPolicyState(home))) return error('stale-policy');
        return result({
          schema: 'stroq-try-action/1',
          source: 'local',
          generatedAt: new Date(now()).toISOString(),
          policySource: current.text === null ? 'default' : 'file',
          kind: input.kind,
          ...judged,
        });
      });
    },
    async preview(input) {
      if (
        !keys(input, ['expectedRawSha', 'changes']) ||
        !rawDigest(input.expectedRawSha) ||
        !validChanges(input.changes)
      )
        return error('invalid-request');
      return exclusive(async () => {
        const current = await readPolicyState(home);
        if (current.rawSha !== input.expectedRawSha) return error('stale-policy');
        const cases = await caseStore.capture();
        const prepared = await adapter('preview', current.text, input.changes, {
          signal: abort.signal,
          cases: cases.records,
          caseRevision: cases.revision,
        });
        const schema = await import(
          pathToFileURL(runtimeLayout().adapter('local-api-schema.js')).href
        );
        const regressions = prepared?.regressions;
        const evaluation = regressions
          ? {
              policyFingerprint: prepared.candidateFingerprint,
              total: regressions.total,
              passed: regressions.passed,
              failed: regressions.failed,
              results: regressions.results,
            }
          : null;
        if (
          !digest(prepared?.candidateFingerprint) ||
          !digest(prepared?.currentPolicyFingerprint) ||
          typeof prepared.candidateText !== 'string' ||
          Buffer.byteLength(prepared.candidateText, 'utf8') > MAX_POLICY_BYTES ||
          !Array.isArray(prepared.blockers) ||
          !validActionControl(prepared, input.changes.denyActionClasses) ||
          typeof schema.validatePolicyCaseRegressions !== 'function' ||
          !schema.validatePolicyCaseRegressions(regressions) ||
          regressions.revision !== cases.revision ||
          !schema.validatePolicyCaseEvaluation(evaluation, cases.records) ||
          (regressions.failed > 0 && !prepared.blockers.includes('saved-case-failures'))
        )
          return error('engine-failed');
        const after = await readPolicyState(home);
        if (!samePolicyRevision(current, after)) return error('stale-policy');
        await caseStore.assertSnapshot(cases);
        const { candidateText, ...projection } = prepared;
        const previewId = randomUUID();
        const expires = now() + TTL;
        const body = {
          previewId,
          expiresAt: new Date(expires).toISOString(),
          expectedRawSha: current.rawSha,
          ...projection,
        };
        sweep();
        previews.set(previewId, { current, candidateText, body, expires, cases });
        return result(body);
      });
    },
    async apply(input) {
      if (
        !keys(input, [
          'previewId',
          'expectedRawSha',
          'candidateFingerprint',
          'acknowledgeInterruptions',
          'acknowledgeActionScope',
        ]) ||
        typeof input.previewId !== 'string' ||
        !UUID.test(input.previewId) ||
        !rawDigest(input.expectedRawSha) ||
        !digest(input.candidateFingerprint) ||
        (input.acknowledgeInterruptions !== undefined &&
          typeof input.acknowledgeInterruptions !== 'boolean') ||
        (input.acknowledgeActionScope !== undefined &&
          typeof input.acknowledgeActionScope !== 'boolean')
      )
        return error('invalid-request');
      return exclusive(async () => {
        const preview = previews.get(input.previewId);
        if (!preview || preview.expires <= now()) {
          previews.delete(input.previewId);
          return error('preview-expired');
        }
        if (
          preview.current.rawSha !== input.expectedRawSha ||
          preview.body.candidateFingerprint !== input.candidateFingerprint
        )
          return error('preview-mismatch');
        if (
          preview.body.blockers.length > 0 ||
          preview.body.check?.ok !== true ||
          preview.body.simulation?.ok !== true ||
          preview.body.simulation.attacksPassing > 0 ||
          preview.body.simulation.notJudged > 0 ||
          preview.body.simulation.violations > 0 ||
          preview.body.regressions.failed > 0
        )
          return error('checks-failed');
        if (
          (preview.body.requiresInterruptionAcknowledgement ||
            preview.body.simulation.newInterruptions > 0) &&
          input.acknowledgeInterruptions !== true
        )
          return error('interruption-ack-required');
        if (preview.body.actionControl !== null && input.acknowledgeActionScope !== true)
          return error('action-scope-ack-required');
        const beforeLock = await readPolicyState(home).catch(() => null);
        if (!beforeLock || !samePolicyRevision(preview.current, beforeLock))
          return error('stale-policy');
        return caseStore.withSnapshotLock(preview.cases, async (_cases, _replace, location) => {
          const current = await readPolicyState(home).catch(() => null);
          // The case lock may create a previously absent home. Rebind only to
          // that exact, privately pinned directory, while policy bytes remain absent.
          const createdHome = location?.createdHome;
          const ownsHomeCreation =
            preview.current.rootStat === null &&
            createdHome !== null &&
            createdHome !== undefined &&
            current?.rootStat?.dev === createdHome.dev &&
            current?.rootStat?.ino === createdHome.ino &&
            current.root === preview.current.root &&
            current.rawSha === null &&
            current.bytes === null;
          if (!current || (!samePolicyRevision(preview.current, current) && !ownsHomeCreation))
            return error('stale-policy');
          const inspection = await adapter('inspect', current.text, undefined, {
            signal: abort.signal,
          });
          if (inspection.policyFingerprint !== preview.body.currentPolicyFingerprint)
            return error('stale-policy');
          const receipt = await applyPolicyBytes(
            ownsHomeCreation ? current : preview.current,
            preview.candidateText,
            input.candidateFingerprint,
            now(),
          );
          previews.clear();
          return result(receipt);
        });
      });
    },
    async close() {
      closed = true;
      abort.abort();
      await pending;
      previews.clear();
    },
  };
}
