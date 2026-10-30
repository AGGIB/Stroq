import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse, stringify } from 'yaml';
import {
  ACTION_CLASSES,
  AuditLog,
  DEFAULT_POLICY,
  evaluatePolicy,
  stableStringify,
} from '../../packages/core/dist/index.js';
import { startServer } from './serve.mjs';

const SELECTED = 'shell.network';
const UNRELATED = 'mcp.call';
const PRIVATE = [
  'PRIVATE_POLICY_COMMENT',
  'PRIVATE_RULE_ID',
  'PRIVATE_POLICY_REASON',
  'PRIVATE_SESSION',
  'PRIVATE_COMMAND_VALUE',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const semantic = (policy) => hash(stableStringify(policy));
const actionControl = {
  classes: [SELECTED],
  removedRules: 1,
  narrowedRules: 1,
  taint: 'any',
  scope: 'stroq-home',
  hostEnforcement: false,
};

async function fixture(t, { unsafeAllow = false } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-policy-actions-http-')));
  const userHome = join(dir, 'profile'),
    project = join(dir, 'workspace'),
    root = join(dir, 'out'),
    home = join(userHome, '.stroq');
  await Promise.all([userHome, project, root].map((path) => mkdir(path)));
  await mkdir(home, { mode: 0o700 });
  await writeFile(join(root, 'index.html'), 'policy fixture');
  const sentinel = join(dir, 'must-not-execute');
  const ownerRule = {
    id: 'PRIVATE_RULE_ID',
    effect: 'allow',
    reason: `PRIVATE_POLICY_REASON node -e "require('node:fs').writeFileSync('${sentinel}','bad')"`,
    when: { classes: [SELECTED, UNRELATED], taint: 'none' },
  };
  const policy = {
    ...structuredClone(DEFAULT_POLICY),
    // Keep the baseline's unconditional guards ahead of a legitimate custom allow.
    // A broad allow ahead of those guards can independently fail attack replay.
    rules: unsafeAllow
      ? [ownerRule, ...structuredClone(DEFAULT_POLICY.rules)]
      : [
          ...structuredClone(DEFAULT_POLICY.rules.slice(0, 7)),
          ownerRule,
          ...structuredClone(DEFAULT_POLICY.rules.slice(7)),
        ],
  };
  const original = Buffer.from(
    '# PRIVATE_POLICY_COMMENT: preserve owner context\n' + stringify(policy),
  );
  const file = join(home, 'policy.yaml');
  await writeFile(file, original, { mode: 0o600 });
  const auditFile = join(home, 'audit.jsonl'),
    journal = new AuditLog(auditFile);
  for (const classes of [[SELECTED], [SELECTED, UNRELATED]])
    await journal.append({
      sessionId: 'PRIVATE_SESSION',
      phase: 'pre',
      tool: 'Bash',
      summary: 'PRIVATE_COMMAND_VALUE',
      classes,
      decision: { effect: 'ask', ruleId: 'PRIVATE_RULE_ID', reason: 'PRIVATE_POLICY_REASON' },
    });
  let app = await startServer({ root, home, userHome, project, port: 0 });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const validate = await import('../.local-engine/local-api-schema.js');
  async function request(path, body, extra = {}) {
    const origin = new URL(app.url).origin;
    const headers = {
      Authorization: `Bearer ${app.token}`,
      Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...extra.headers,
    };
    for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
    const response = await fetch(origin + path, {
      method: extra.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body: extra.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  async function inspect() {
    const result = await request('/api/policy');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(validate.validatePolicy(result.body), true);
    return result.body;
  }
  async function preview(changes = { denyActionClasses: [SELECTED] }) {
    const current = await inspect();
    return request('/api/policy/preview', { expectedRawSha: current.expectedRawSha, changes });
  }
  const restart = async () => {
    await app.close();
    app = await startServer({ root, home, userHome, project, port: 0 });
  };
  return {
    dir,
    home,
    project,
    userHome,
    file,
    auditFile,
    original,
    policy,
    ownerRule,
    sentinel,
    request,
    inspect,
    preview,
    restart,
    validate,
  };
}
const commit = (preview) => ({
  previewId: preview.previewId,
  expectedRawSha: preview.expectedRawSha,
  candidateFingerprint: preview.candidateFingerprint,
});
function privateOutput(value, f) {
  const output = JSON.stringify(value);
  for (const marker of [...PRIVATE, f.dir, f.home, f.file, f.sentinel])
    assert.equal(output.includes(marker), false, marker);
  assert.equal(Object.hasOwn(value, 'candidateText'), false);
}

test('actual HTTP class control closes the exact recorded-class comparison with separate consent and backed-up apply', async (t) => {
  const f = await fixture(t),
    initial = await f.inspect();
  assert.equal(initial.check.ok, true);
  assert.equal(initial.expectedRawSha, hash(f.original));
  const journal = (await f.request('/api/incidents')).body;
  const incident = journal.incidents.find((value) => value.sequence === 1),
    mixed = journal.incidents.find((value) => value.sequence === 2);
  assert.ok(incident);
  assert.ok(mixed);
  const bound = { id: incident.id, expectedEvidenceSha: incident.evidenceSha };
  const before = await f.request('/api/incidents/compare', bound);
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.equal(f.validate.validateIncidentComparison(before.body), true);
  assert.deepEqual(
    before.body.scenarios.map((value) => value.effect),
    ['allow', 'deny'],
  );
  const auditBefore = await readFile(f.auditFile),
    filesBefore = (await readdir(f.home)).sort();
  const preview = await f.preview();
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const p = preview.body;
  assert.equal(f.validate.validatePolicyPreview(p), true);
  assert.deepEqual(p.actionControl, actionControl);
  assert.ok(p.changes.some((value) => value.field === 'class-deny'));
  assert.equal(p.check.ok, true);
  assert.deepEqual(p.blockers, []);
  assert.ok(p.simulation.replayed.attack > 0);
  assert.ok(p.simulation.replayed.ordinary > 0);
  assert.equal(p.simulation.attacksPassing, 0);
  assert.equal(p.simulation.notJudged, 0);
  assert.equal(p.simulation.violations, 0);
  assert.ok(p.simulation.newInterruptions > 0);
  assert.equal(p.requiresInterruptionAcknowledgement, true);
  assert.deepEqual(await readFile(f.file), f.original);
  assert.deepEqual((await readdir(f.home)).sort(), filesBefore);
  await assert.rejects(access(f.sentinel));
  const input = commit(p);
  assert.equal(
    (await f.request('/api/policy/apply', { ...input, acknowledgeInterruptions: true })).status,
    422,
  );
  assert.deepEqual(await readFile(f.file), f.original);
  assert.equal(
    (await f.request('/api/policy/apply', { ...input, acknowledgeActionScope: true })).status,
    422,
  );
  assert.deepEqual(await readFile(f.file), f.original);
  const applied = await f.request('/api/policy/apply', {
    ...input,
    acknowledgeActionScope: true,
    acknowledgeInterruptions: true,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(f.validate.validatePolicyReceipt(applied.body), true);
  assert.equal(applied.body.policyFingerprint, p.candidateFingerprint);
  assert.ok(applied.body.backupId);
  const changed = await readFile(f.file),
    policy = parse(changed.toString('utf8'));
  assert.equal(applied.body.rawSha, hash(changed));
  assert.equal(applied.body.policyFingerprint, semantic(policy));
  assert.ok(changed.toString('utf8').includes('# PRIVATE_POLICY_COMMENT: preserve owner context'));
  const narrowed = policy.rules.find((value) => value.id === f.ownerRule.id);
  assert.deepEqual(narrowed, {
    ...f.ownerRule,
    when: { ...f.ownerRule.when, classes: [UNRELATED] },
  });
  const backup = join(f.home, 'backups', 'console-policy', `${applied.body.backupId}.yaml`);
  assert.deepEqual(await readFile(backup), f.original);
  assert.equal((await stat(backup)).mode & 0o777, 0o600);
  for (const taint of [null, 'suspect']) {
    for (const classes of [[SELECTED], [SELECTED, UNRELATED]])
      assert.equal(evaluatePolicy(policy, classes, taint).effect, 'deny');
    for (const action of ACTION_CLASSES.filter((value) => value !== SELECTED))
      assert.equal(
        evaluatePolicy(policy, [action], taint).effect,
        evaluatePolicy(f.policy, [action], taint).effect,
        `${action}/${taint}`,
      );
  }
  const after = await f.request('/api/incidents/compare', bound);
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.equal(f.validate.validateIncidentComparison(after.body), true);
  assert.equal(after.body.incidentId, bound.id);
  assert.equal(after.body.evidenceSha, bound.expectedEvidenceSha);
  assert.equal(after.body.currentPolicy.semanticSha, applied.body.policyFingerprint);
  assert.deepEqual(
    after.body.scenarios.map((value) => value.effect),
    ['deny', 'deny'],
  );
  const mixedResult = await f.request('/api/incidents/compare', {
    id: mixed.id,
    expectedEvidenceSha: mixed.evidenceSha,
  });
  assert.equal(mixedResult.status, 200);
  assert.deepEqual(
    mixedResult.body.scenarios.map((value) => value.effect),
    ['deny', 'deny'],
  );
  assert.deepEqual(await readFile(f.auditFile), auditBefore);
  const unchangedReview = (await f.request('/api/incidents')).body.incidents.find(
    (value) => value.id === incident.id,
  );
  assert.equal(unchangedReview.status, 'open');
  assert.equal(unchangedReview.reviewedAt, null);
  assert.equal(
    (
      await f.request('/api/policy/apply', {
        ...input,
        acknowledgeActionScope: true,
        acknowledgeInterruptions: true,
      })
    ).status,
    409,
  );
  for (const value of [initial, p, applied.body, after.body, mixedResult.body])
    privateOutput(value, f);
  await assert.rejects(access(f.sentinel));
  await f.restart();
  const persisted = await f.inspect();
  assert.equal(persisted.policyFingerprint, applied.body.policyFingerprint);
  assert.equal(persisted.expectedRawSha, applied.body.rawSha);
  const rechecked = await f.request('/api/incidents/compare', bound);
  assert.equal(rechecked.status, 200);
  assert.deepEqual(
    rechecked.body.scenarios.map((value) => value.effect),
    ['deny', 'deny'],
  );
  assert.deepEqual((await f.request('/api/control')).body.runs, []);
});

test('raw owner edits invalidate class-control previews without overwriting or creating a backup', async (t) => {
  const f = await fixture(t),
    preview = await f.preview();
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const newer = Buffer.concat([f.original, Buffer.from('# later owner edit\n')]);
  await writeFile(f.file, newer);
  const result = await f.request('/api/policy/apply', {
    ...commit(preview.body),
    acknowledgeActionScope: true,
    acknowledgeInterruptions: true,
  });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.error, 'stale-policy');
  assert.deepEqual(await readFile(f.file), newer);
  await assert.rejects(access(join(f.home, 'backups')));
});

test('an independently unsafe earlier allow keeps the candidate blocked despite the requested class deny', async (t) => {
  const f = await fixture(t, { unsafeAllow: true });
  const preview = await f.preview();
  assert.equal(preview.status, 200);
  assert.ok(preview.body.simulation.attacksPassing > 0);
  assert.ok(preview.body.blockers.includes('attacks-allowed'));
  const result = await f.request('/api/policy/apply', {
    ...commit(preview.body),
    acknowledgeActionScope: true,
    acknowledgeInterruptions: true,
  });
  assert.equal(result.status, 422);
  assert.equal(result.body.error, 'checks-failed');
  assert.deepEqual(await readFile(f.file), f.original);
  await assert.rejects(access(join(f.home, 'backups')));
});

test('class controls reject unknown, duplicate, empty and oversized requests through existing HTTP gates', async (t) => {
  const f = await fixture(t),
    current = await f.inspect(),
    path = '/api/policy/preview';
  const input = {
    expectedRawSha: current.expectedRawSha,
    changes: { denyActionClasses: [SELECTED] },
  };
  assert.equal(
    (await f.request(path, input, { headers: { Authorization: undefined } })).status,
    401,
  );
  assert.equal(
    (await f.request(path, input, { headers: { Origin: 'https://foreign.invalid' } })).status,
    403,
  );
  assert.equal((await f.request(path, input, { headers: { Origin: undefined } })).status, 403);
  assert.equal(
    (await f.request(path, input, { headers: { 'Content-Type': 'text/plain' } })).status,
    415,
  );
  assert.equal((await f.request(path, undefined)).status, 405);
  const invalid = [
    [],
    [SELECTED, SELECTED],
    ['PRIVATE_UNKNOWN_ACTION'],
    [42],
    [null],
    null,
    SELECTED,
    Array(21).fill(SELECTED),
  ];
  for (const denyActionClasses of invalid) {
    const result = await f.request(path, { ...input, changes: { denyActionClasses } });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    privateOutput(result.body, f);
  }
  for (const body of [
    { ...input, path: join(f.dir, 'outside') },
    { ...input, changes: { ...input.changes, command: 'PRIVATE_COMMAND_VALUE' } },
    { ...input, changes: { denyActionClasses: [SELECTED], scope: 'workspace' } },
  ])
    assert.equal((await f.request(path, body)).status, 400);
  assert.equal(
    (await f.request(path, input, { raw: Buffer.alloc(16 * 1024 + 1, 'x') })).status,
    413,
  );
  assert.deepEqual(await readFile(f.file), f.original);
  await assert.rejects(access(join(f.home, 'backups')));
  await assert.rejects(access(f.sentinel));
});
