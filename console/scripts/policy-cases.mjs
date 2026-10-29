import { pathToFileURL } from 'node:url';
import { readPolicyState, samePolicyRevision } from './policy-files.mjs';
import { runtimeLayout } from './runtime-layout.mjs';
import { createPolicyCasesStore, MAX_POLICY_CASES, policyCaseId } from './policy-cases-store.mjs';

const SHA = /^[a-f0-9]{64}$/;
const digest = (v) => typeof v === 'string' && SHA.test(v);
const nullableDigest = (v) => v === null || digest(v);
const closed = (v, keys) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype &&
  Reflect.ownKeys(v).length === keys.length &&
  Reflect.ownKeys(v).every((key) => typeof key === 'string' && keys.includes(key));
const fail = (code) => {
  throw new Error(code);
};
const STATUS = new Map([
  ['invalid-request', 400],
  ['policy-cases-stale', 409],
  ['policy-cases-unavailable', 503],
  ['policy-cases-invalid', 422],
  ['policy-cases-busy', 409],
  ['policy-cases-full', 422],
  ['policy-case-conflict', 409],
  ['policy-case-missing', 409],
  ['stale-policy', 409],
  ['stale-evidence', 409],
  ['unsupported-evidence', 422],
  ['policy-unavailable', 422],
  ['policy-invalid', 422],
  ['server-stopped', 503],
  ['busy', 409],
  ['engine-unavailable', 503],
  ['engine-failed', 502],
  ['deadline-exceeded', 504],
]);
const error = (code) => ({
  status: STATUS.get(code) ?? 502,
  body: { error: STATUS.has(code) ? code : 'engine-failed' },
});
const success = (body) => ({ status: 200, body: structuredClone(body) });
function saveRequest(v) {
  return (
    closed(v, [
      'incidentId',
      'expectedEvidenceSha',
      'expectedPolicyFingerprint',
      'expectedPolicyRawSha',
      'expectedStoreRevision',
      'acknowledgeSharedScope',
    ]) &&
    digest(v.expectedEvidenceSha) &&
    v.incidentId === `incident-${v.expectedEvidenceSha}` &&
    digest(v.expectedPolicyFingerprint) &&
    nullableDigest(v.expectedPolicyRawSha) &&
    nullableDigest(v.expectedStoreRevision) &&
    v.acknowledgeSharedScope === true
  );
}
function removeRequest(v) {
  return (
    closed(v, [
      'caseId',
      'expectedStoreRevision',
      'acknowledgeWeakenChecks',
      'acknowledgeSharedScope',
    ]) &&
    typeof v.caseId === 'string' &&
    /^case-[a-f0-9]{64}$/.test(v.caseId) &&
    nullableDigest(v.expectedStoreRevision) &&
    v.acknowledgeWeakenChecks === true &&
    v.acknowledgeSharedScope === true
  );
}

/** Cases are shared by a Stroq policy home. Request data never selects a path or supplies predicates. */
export function createPolicyCasesService({
  home,
  store = createPolicyCasesStore({ home }),
  compare,
  evaluate,
  workspaceId,
  now = Date.now,
  loadSchema = () => import(pathToFileURL(runtimeLayout().adapter('local-api-schema.js')).href),
} = {}) {
  if (
    typeof compare !== 'function' ||
    typeof evaluate !== 'function' ||
    typeof workspaceId !== 'string' ||
    !/^workspace-[a-f0-9]{24}$/.test(workspaceId)
  )
    throw new TypeError('case-dependencies-required');
  const abort = new AbortController();
  let stopped = false,
    pending = null;
  const checkOpen = () => {
    if (stopped) fail('server-stopped');
  };
  const timestamp = () => {
    const at = now(),
      date = at instanceof Date ? at : new Date(at);
    if (!Number.isFinite(date.getTime())) fail('engine-failed');
    return date.toISOString();
  };
  async function schema() {
    try {
      const loaded = await loadSchema();
      if (
        ![
          'validateIncidentComparison',
          'validatePolicyCaseEvaluation',
          'validatePolicyCases',
          'validatePolicyCaseReceipt',
        ].every((key) => typeof loaded[key] === 'function') ||
        !Array.isArray(loaded.CASE_LIMITATIONS)
      )
        fail('engine-unavailable');
      return loaded;
    } catch {
      fail('engine-unavailable');
    }
  }
  function exclusive(operation, reading = false) {
    if (stopped) return Promise.resolve(error('server-stopped'));
    if (pending) return Promise.resolve(error('policy-cases-busy'));
    pending = Promise.resolve()
      .then(operation)
      .catch((cause) =>
        reading
          ? { status: 503, body: { error: 'policy-cases-unavailable' } }
          : error(cause?.message),
      )
      .finally(() => {
        pending = null;
      });
    return pending;
  }
  async function evaluateCurrent(schema, policy, records, signal) {
    const report = await evaluate(policy.text, records, {
      signal: signal ? AbortSignal.any([abort.signal, signal]) : abort.signal,
    });
    checkOpen();
    if (!schema.validatePolicyCaseEvaluation(report, records)) fail('engine-failed');
    return report;
  }
  async function unchangedPolicy(before) {
    const after = await readPolicyState(home).catch(() => fail('stale-policy'));
    if (!samePolicyRevision(before, after)) fail('stale-policy');
    return after;
  }
  function receipt(schema, status, record, snapshot, caseId = record?.id) {
    const body = {
      schema: 'stroq-policy-case-receipt/1',
      status,
      caseId,
      revision: snapshot.revision,
      completedAt: timestamp(),
      workspaceId,
      record,
      hostEnforcement: false,
    };
    if (!schema.validatePolicyCaseReceipt(body)) fail('engine-failed');
    return success(body);
  }
  async function comparison(schema, input, policy) {
    const result = await compare({
      id: input.incidentId,
      expectedEvidenceSha: input.expectedEvidenceSha,
    });
    checkOpen();
    if (
      !schema.validateIncidentComparison(result) ||
      result.incidentId !== input.incidentId ||
      result.evidenceSha !== input.expectedEvidenceSha
    )
      fail('engine-failed');
    if (!result.classes.length) fail('unsupported-evidence');
    if (
      result.currentPolicy.semanticSha !== input.expectedPolicyFingerprint ||
      result.currentPolicy.rawSha !== input.expectedPolicyRawSha ||
      result.currentPolicy.rawSha !== policy.rawSha
    )
      fail('stale-policy');
    return {
      classes: [...result.classes].sort(),
      expected: result.scenarios.map((s) => ({ taint: s.taint, effect: s.effect })),
    };
  }
  return {
    read({ signal } = {}) {
      return exclusive(async () => {
        const guards = await schema();
        const snapshot = await store.capture();
        const policy = await readPolicyState(home);
        const evaluation = await evaluateCurrent(guards, policy, snapshot.records, signal);
        await unchangedPolicy(policy);
        await store.assertSnapshot(snapshot);
        checkOpen();
        const { policyFingerprint, ...counts } = evaluation;
        const body = {
          schema: 'stroq-policy-cases/1',
          source: 'local',
          workspaceId,
          generatedAt: timestamp(),
          revision: snapshot.revision,
          cases: snapshot.records,
          report: {
            policy: {
              source: policy.text === null ? 'built-in' : 'file',
              semanticSha: policyFingerprint,
              rawSha: policy.rawSha,
            },
            ...counts,
            hostEnforcement: false,
          },
          limitations: [...guards.CASE_LIMITATIONS],
        };
        if (!guards.validatePolicyCases(body)) fail('engine-failed');
        return success(body);
      }, true);
    },
    save(input) {
      if (!saveRequest(input)) return Promise.resolve(error('invalid-request'));
      input = Object.freeze({ ...input });
      return exclusive(async () => {
        const guards = await schema();
        const snapshot = await store.capture();
        if (snapshot.revision !== input.expectedStoreRevision) fail('policy-cases-stale');
        return store.withSnapshotLock(snapshot, async (fresh, replace) => {
          checkOpen();
          const policy = await readPolicyState(home);
          if (policy.rawSha !== input.expectedPolicyRawSha) fail('stale-policy');
          const derived = await comparison(guards, input, policy);
          const id = policyCaseId(derived.classes, derived.expected);
          const existing = fresh.records.find(
            (r) => JSON.stringify(r.classes) === JSON.stringify(derived.classes),
          );
          if (existing && existing.id !== id) fail('policy-case-conflict');
          if (!existing && fresh.records.length >= MAX_POLICY_CASES) fail('policy-cases-full');
          const record = existing ?? {
            id,
            createdAt: timestamp(),
            source: {
              incidentId: input.incidentId,
              evidenceSha: input.expectedEvidenceSha,
              workspaceId,
            },
            ...derived,
          };
          const evaluation = await evaluateCurrent(guards, policy, [record]);
          if (evaluation.policyFingerprint !== input.expectedPolicyFingerprint)
            fail('stale-policy');
          if (evaluation.failed !== 0) fail('engine-failed');
          const confirmed = await comparison(guards, input, policy);
          if (JSON.stringify(confirmed) !== JSON.stringify(derived)) fail('stale-evidence');
          await unchangedPolicy(policy);
          checkOpen();
          if (existing) return receipt(guards, 'unchanged', existing, fresh);
          return receipt(guards, 'saved', record, await replace([...fresh.records, record]));
        });
      });
    },
    remove(input) {
      if (!removeRequest(input)) return Promise.resolve(error('invalid-request'));
      input = Object.freeze({ ...input });
      return exclusive(async () => {
        const guards = await schema();
        const snapshot = await store.capture();
        if (snapshot.revision !== input.expectedStoreRevision) fail('policy-cases-stale');
        return store.withSnapshotLock(snapshot, async (fresh, replace) => {
          checkOpen();
          if (!fresh.records.some((r) => r.id === input.caseId)) fail('policy-case-missing');
          const next = await replace(fresh.records.filter((r) => r.id !== input.caseId));
          return receipt(guards, 'removed', null, next, input.caseId);
        });
      });
    },
    async close() {
      stopped = true;
      abort.abort();
      await pending?.catch(() => undefined);
    },
  };
}
