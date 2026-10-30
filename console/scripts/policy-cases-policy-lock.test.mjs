import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { DEFAULT_POLICY, evaluatePolicy, stableStringify } from '../../packages/core/dist/index.js';
import { createPolicyService } from './policy-service.mjs';
import { createPolicyCasesStore, policyCaseId } from './policy-cases-store.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const semantic = (policy) => hash(stableStringify(policy));
const check = { ok: true, loaded: true, faults: 0, findings: [] };
function record(classes = ['shell.network']) {
  const expected = ['none', 'suspect'].map((taint) => ({
    taint,
    effect: evaluatePolicy(DEFAULT_POLICY, classes, taint === 'none' ? null : 'suspect').effect,
  }));
  return {
    id: policyCaseId(classes, expected),
    createdAt: '2026-10-23T01:00:00.000Z',
    source: {
      incidentId: 'incident-' + 'a'.repeat(64),
      evidenceSha: 'a'.repeat(64),
      workspaceId: 'workspace-' + 'a'.repeat(24),
    },
    classes,
    expected,
  };
}
function gate() {
  let release, entered;
  const started = new Promise((done) => {
      entered = done;
    }),
    held = new Promise((done) => {
      release = done;
    });
  return {
    started,
    release,
    wait: async () => {
      entered();
      await held;
    },
  };
}
async function within(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('fixture gate timed out')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function fixture(t, records = []) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-policy-case-commit-lock-'))),
    home = join(dir, 'home');
  await mkdir(home, { mode: 0o700 });
  const file = join(home, 'policy.yaml'),
    original = stringify(DEFAULT_POLICY);
  const candidatePolicy = { ...structuredClone(DEFAULT_POLICY), threshold: 0.5 },
    candidate = stringify(candidatePolicy);
  await writeFile(file, original, { mode: 0o600 });
  const store = createPolicyCasesStore({ home }),
    other = createPolicyCasesStore({ home });
  await store.withSnapshotLock(await store.capture(), async (_fresh, replace) => replace(records));
  let onInspect = async () => {};
  // Only evaluation is injected. Both stores, both core locks and policy byte
  // replacement are the production parent implementations against temp files.
  const adapter = async (operation, _text, _changes, options) => {
    if (operation === 'inspect') {
      await onInspect();
      return {
        policyFingerprint: semantic(DEFAULT_POLICY),
        defaultEffect: 'allow',
        threshold: 0.6,
        rules: [],
        check,
        editable: true,
      };
    }
    const results = options.cases.map((value) => ({
      caseId: value.id,
      passed: true,
      scenarios: value.expected.map(({ taint, effect }) => ({
        taint,
        expected: effect,
        actual: evaluatePolicy(candidatePolicy, value.classes, taint === 'none' ? null : 'suspect')
          .effect,
      })),
    }));
    return {
      candidateText: candidate,
      currentPolicyFingerprint: semantic(DEFAULT_POLICY),
      candidateFingerprint: semantic(candidatePolicy),
      changes: [{ field: 'threshold', from: 0.6, to: 0.5 }],
      actionControl: null,
      check,
      simulation: {
        ok: true,
        replayed: { attack: 1, ordinary: 1, cases: 0 },
        attacksPassing: 0,
        newInterruptions: 0,
        relieved: 0,
        violations: 0,
        notJudged: 0,
      },
      blockers: [],
      requiresInterruptionAcknowledgement: false,
      interruptions: [],
      interruptionsTruncated: false,
      regressions: {
        revision: options.caseRevision,
        total: results.length,
        passed: results.length,
        failed: 0,
        results,
      },
    };
  };
  const service = createPolicyService({ home, caseStore: store, adapter });
  t.after(async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  const preview = await service.preview({
    expectedRawSha: hash(original),
    changes: { threshold: 0.5 },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const apply = () =>
    service.apply({
      previewId: preview.body.previewId,
      expectedRawSha: preview.body.expectedRawSha,
      candidateFingerprint: preview.body.candidateFingerprint,
    });
  return {
    home,
    file,
    original,
    candidate,
    store,
    other,
    apply,
    onInspect: (fn) => {
      onInspect = fn;
    },
  };
}

test('a second instance cannot add a case while policy apply is inspecting and committing', async (t) => {
  const f = await fixture(t),
    held = gate(),
    snapshot = await f.other.capture();
  f.onInspect(held.wait);
  const applying = f.apply();
  await within(held.started);
  let entered = false;
  const adding = f.other.withSnapshotLock(snapshot, async (_fresh, replace) => {
    entered = true;
    assert.equal(
      await readFile(f.file, 'utf8'),
      f.candidate,
      'case lock released before policy byte commit',
    );
    return replace([record()]);
  });
  try {
    await new Promise((done) => setTimeout(done, 40));
    assert.equal(entered, false);
    assert.equal(await readFile(f.file, 'utf8'), f.original);
  } finally {
    held.release();
  }
  const result = await applying;
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const changed = await adding;
  assert.equal(changed.records.length, 1);
  assert.equal(entered, true);
  assert.equal(await readFile(f.file, 'utf8'), f.candidate);
});

test('a case removal holding the shared lock makes a waiting policy apply stale before its writer runs', async (t) => {
  const f = await fixture(t, [record()]),
    held = gate(),
    snapshot = await f.other.capture();
  const removing = f.other.withSnapshotLock(snapshot, async (_fresh, replace) => {
    await held.wait();
    return replace([]);
  });
  await within(held.started);
  let inspected = false;
  f.onInspect(async () => {
    inspected = true;
  });
  const applying = f.apply();
  try {
    await new Promise((done) => setTimeout(done, 40));
    assert.equal(inspected, false);
    assert.equal(await readFile(f.file, 'utf8'), f.original);
  } finally {
    held.release();
  }
  await removing;
  const result = await applying;
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.error, 'policy-cases-stale');
  assert.equal(inspected, false);
  assert.equal(await readFile(f.file, 'utf8'), f.original);
  assert.equal((await f.store.capture()).records.length, 0);
  await assert.rejects(access(join(f.home, 'backups')));
});
