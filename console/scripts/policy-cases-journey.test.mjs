import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { AuditLog, DEFAULT_POLICY } from '../../packages/core/dist/index.js';
import { startServer } from './serve.mjs';

const CLASSES = ['mcp.call', 'shell.network'];
const PRIVATE = ['PRIVATE_CASE_POLICY', 'PRIVATE_CASE_SESSION', 'PRIVATE_CASE_COMMAND'];
const EXPECTED = [
  { taint: 'none', effect: 'allow' },
  { taint: 'suspect', effect: 'deny' },
];
const BASE = '/api/policy/cases';

async function fixture(t, { empty = false } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-policy-cases-http-')));
  const userHome = join(dir, 'profile'),
    project = join(dir, 'workspace'),
    root = join(dir, 'out'),
    home = join(userHome, '.stroq');
  await Promise.all([userHome, project, root].map((path) => mkdir(path)));
  await writeFile(join(root, 'index.html'), 'cases fixture');
  const file = join(home, 'policy.yaml'),
    auditFile = join(home, 'audit.jsonl'),
    storeFile = join(home, 'console', 'policy-cases.json');
  const original = '# PRIVATE_CASE_POLICY\n' + stringify(DEFAULT_POLICY);
  let journal;
  if (!empty) {
    await mkdir(home, { mode: 0o700 });
    await writeFile(file, original, { mode: 0o600 });
    journal = new AuditLog(auditFile);
    await journal.append({
      sessionId: 'PRIVATE_CASE_SESSION',
      phase: 'pre',
      tool: 'Bash',
      summary: 'PRIVATE_CASE_COMMAND',
      classes: CLASSES,
      decision: { effect: 'deny', ruleId: 'PRIVATE_CASE_POLICY', reason: 'PRIVATE_CASE_POLICY' },
    });
  }
  const options = { root, home, userHome, project, port: 0 };
  let app = await startServer(options);
  const others = [];
  t.after(async () => {
    await app.close();
    for (const other of others) await other.close();
    await rm(dir, { recursive: true, force: true });
  });
  const validate = await import('../.local-engine/local-api-schema.js');
  const call = async (server, path, body, extra = {}) => {
    const origin = new URL(server.url).origin;
    const headers = {
      Authorization: `Bearer ${server.token}`,
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
  };
  const request = (...args) => call(app, ...args);
  const restart = async () => {
    await app.close();
    app = await startServer(options);
  };
  const second = async () => {
    const project = join(dir, 'second-workspace');
    await mkdir(project);
    const other = await startServer({ ...options, project });
    others.push(other);
    return (...args) => call(other, ...args);
  };
  const state = async (read = request) => {
    const result = await read(BASE);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(validate.validatePolicyCases(result.body), true);
    return result.body;
  };
  const selected = async () => {
    const list = await request('/api/incidents');
    assert.equal(list.status, 200);
    const incident = list.body.incidents.find((value) => value.sequence === 1);
    assert.ok(incident);
    const comparison = await request('/api/incidents/compare', {
      id: incident.id,
      expectedEvidenceSha: incident.evidenceSha,
    });
    assert.equal(comparison.status, 200, JSON.stringify(comparison.body));
    return { incident, comparison: comparison.body };
  };
  const saveInput = async () => {
    const { incident, comparison } = await selected(),
      current = await state();
    return {
      incidentId: incident.id,
      expectedEvidenceSha: incident.evidenceSha,
      expectedPolicyFingerprint: comparison.currentPolicy.semanticSha,
      expectedPolicyRawSha: comparison.currentPolicy.rawSha,
      expectedStoreRevision: current.revision,
      acknowledgeSharedScope: true,
    };
  };
  return {
    dir,
    userHome,
    project,
    home,
    file,
    auditFile,
    storeFile,
    original,
    journal,
    request,
    restart,
    second,
    state,
    selected,
    saveInput,
    validate,
  };
}
const preview = async (read) => {
  const current = await read('/api/policy');
  assert.equal(current.status, 200, JSON.stringify(current.body));
  return read('/api/policy/preview', {
    expectedRawSha: current.body.expectedRawSha,
    changes: { denyActionClasses: ['shell.network'] },
  });
};
const commit = (p) => ({
  previewId: p.previewId,
  expectedRawSha: p.expectedRawSha,
  candidateFingerprint: p.candidateFingerprint,
  acknowledgeActionScope: true,
  acknowledgeInterruptions: true,
});
function privateOutput(value, f) {
  const output = JSON.stringify(value);
  for (const marker of [...PRIVATE, f.dir, f.home, f.file, f.auditFile, f.storeFile])
    assert.equal(output.includes(marker), false, marker);
}
async function saved(f) {
  const input = await f.saveInput(),
    result = await f.request(BASE + '/save', input);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(f.validate.validatePolicyCaseReceipt(result.body), true);
  return { input, receipt: result.body };
}

test('missing case store is a readonly empty state, including absent Stroq home', async (t) => {
  const f = await fixture(t, { empty: true }),
    current = await f.state();
  assert.equal(current.revision, null);
  assert.deepEqual(current.cases, []);
  assert.equal(current.report.total, 0);
  assert.equal(current.report.hostEnforcement, false);
  assert.equal(current.report.policy.source, 'built-in');
  assert.equal(current.report.policy.rawSha, null);
  await assert.rejects(access(f.home));
  privateOutput(current, f);
});

test('exact recorded cases survive restart and shared-workspace reads, gate policy changes, and require explicit removal', async (t) => {
  const f = await fixture(t),
    source = await f.selected();
  assert.deepEqual(
    source.comparison.scenarios.map(({ taint, effect }) => ({ taint, effect })),
    EXPECTED,
  );
  const auditBefore = await readFile(f.auditFile),
    { input, receipt } = await saved(f);
  assert.equal(receipt.status, 'saved');
  assert.match(receipt.caseId, /^case-[a-f0-9]{64}$/);
  assert.match(receipt.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(receipt.record.classes, CLASSES);
  assert.deepEqual(receipt.record.expected, EXPECTED);
  assert.equal(receipt.hostEnforcement, false);
  assert.equal(receipt.record.source.incidentId, input.incidentId);
  assert.equal(receipt.record.source.evidenceSha, input.expectedEvidenceSha);
  const initial = await f.state();
  assert.equal(initial.cases.length, 1);
  assert.equal(initial.report.passed, 1);
  assert.equal(initial.report.failed, 0);
  assert.equal(initial.cases[0].source.workspaceId, initial.workspaceId);
  const unchanged = await f.request(BASE + '/save', {
    ...input,
    expectedStoreRevision: initial.revision,
  });
  assert.equal(unchanged.status, 200, JSON.stringify(unchanged.body));
  assert.equal(unchanged.body.status, 'unchanged');
  assert.equal(unchanged.body.revision, initial.revision);
  await f.restart();
  const restored = await f.state();
  assert.equal(restored.revision, initial.revision);
  assert.equal(restored.cases[0].id, receipt.caseId);
  const other = await f.second(),
    shared = await f.state(other);
  assert.notEqual(shared.workspaceId, initial.workspaceId);
  assert.equal(shared.cases[0].source.workspaceId, initial.workspaceId);
  assert.equal(shared.revision, initial.revision);
  assert.equal(shared.report.passed, 1);
  const blocked = await preview(other);
  assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
  const p = blocked.body;
  assert.equal(f.validate.validatePolicyPreview(p), true);
  assert.equal(p.simulation.attacksPassing, 0);
  assert.equal(p.simulation.notJudged, 0);
  assert.equal(p.simulation.violations, 0);
  assert.equal(p.regressions.revision, shared.revision);
  assert.equal(p.regressions.total, 1);
  assert.equal(p.regressions.failed, 1);
  assert.equal(p.regressions.passed, 0);
  assert.ok(p.blockers.includes('saved-case-failures'));
  const result = p.regressions.results.find((value) => value.caseId === receipt.caseId);
  assert.ok(result);
  assert.equal(result.passed, false);
  assert.deepEqual(
    result.scenarios.map(({ taint, expected, actual }) => ({ taint, expected, actual })),
    [
      { taint: 'none', expected: 'allow', actual: 'deny' },
      { taint: 'suspect', expected: 'deny', actual: 'deny' },
    ],
  );
  assert.equal((await other('/api/policy/apply', commit(p))).status, 422);
  assert.equal(await readFile(f.file, 'utf8'), f.original);
  const remove = { caseId: receipt.caseId, expectedStoreRevision: shared.revision };
  for (const acknowledgements of [
    { acknowledgeWeakenChecks: true },
    { acknowledgeSharedScope: true },
  ]) {
    const refused = await other(BASE + '/remove', { ...remove, ...acknowledgements });
    assert.ok([400, 422].includes(refused.status), JSON.stringify(refused));
    assert.equal((await f.state()).cases.length, 1);
  }
  const removed = await other(BASE + '/remove', {
    ...remove,
    acknowledgeWeakenChecks: true,
    acknowledgeSharedScope: true,
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(f.validate.validatePolicyCaseReceipt(removed.body), true);
  assert.equal(removed.body.status, 'removed');
  assert.equal(removed.body.record, null);
  assert.equal(removed.body.workspaceId, shared.workspaceId);
  assert.equal((await f.state(other)).cases.length, 0);
  const fresh = await preview(other);
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal(fresh.body.regressions.total, 0);
  assert.equal(fresh.body.regressions.failed, 0);
  const applied = await other('/api/policy/apply', commit(fresh.body));
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.policyFingerprint, fresh.body.candidateFingerprint);
  const final = await f.state();
  assert.equal(final.report.total, 0);
  assert.equal(final.report.policy.semanticSha, applied.body.policyFingerprint);
  assert.deepEqual(await readFile(f.auditFile), auditBefore);
  for (const value of [receipt, initial, restored, shared, p, removed.body, applied.body, final])
    privateOutput(value, f);
});

test('adding a case after policy preview makes the approved policy change stale', async (t) => {
  const f = await fixture(t),
    before = await preview(f.request);
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.equal(before.body.regressions.total, 0);
  await saved(f);
  const result = await f.request('/api/policy/apply', commit(before.body));
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.error, 'policy-cases-stale');
  assert.equal(await readFile(f.file, 'utf8'), f.original);
  await assert.rejects(access(join(f.home, 'backups')));
});

test('save refuses stale policy bytes and stale source evidence without manufacturing a case', async (t) => {
  const f = await fixture(t),
    input = await f.saveInput();
  const newer = f.original + '# current owner edit\n';
  await writeFile(f.file, newer);
  const changed = await f.request(BASE + '/save', input);
  assert.equal(changed.status, 409, JSON.stringify(changed.body));
  assert.equal(await readFile(f.file, 'utf8'), newer);
  await assert.rejects(access(f.storeFile));
  await writeFile(f.file, f.original);
  await writeFile(
    f.auditFile,
    (await readFile(f.auditFile, 'utf8')).replace(
      'PRIVATE_CASE_COMMAND',
      'PRIVATE_CASE_COMMAND_CHANGED',
    ),
  );
  const stale = await f.request(BASE + '/save', input);
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  await assert.rejects(access(f.storeFile));
  privateOutput(changed.body, f);
  privateOutput(stale.body, f);
});

test('malformed retained case JSON is unavailable rather than an empty successful check', async (t) => {
  const f = await fixture(t);
  await saved(f);
  const original = await readFile(f.storeFile, 'utf8'),
    doc = JSON.parse(original),
    key = Object.keys(doc)[0];
  const duplicated = original.replace('{', `{${JSON.stringify(key)}:${JSON.stringify(doc[key])},`);
  await writeFile(f.storeFile, duplicated);
  const state = await f.request(BASE);
  assert.equal(state.status, 503, JSON.stringify(state.body));
  assert.equal(state.body.error, 'policy-cases-unavailable');
  assert.equal(Object.hasOwn(state.body, 'report'), false);
  const candidate = await preview(f.request);
  assert.equal(candidate.status, 503, JSON.stringify(candidate.body));
  assert.ok(['policy-cases-unavailable', 'policy-cases-invalid'].includes(candidate.body.error));
  assert.equal(await readFile(f.storeFile, 'utf8'), duplicated);
  assert.equal(await readFile(f.file, 'utf8'), f.original);
  privateOutput(state.body, f);
  privateOutput(candidate.body, f);
});

test('case endpoints retain authentication, strict body bounds and server-derived fields', async (t) => {
  const f = await fixture(t),
    input = await f.saveInput();
  for (const path of [BASE, BASE + '/save', BASE + '/remove']) {
    const body = path === BASE ? undefined : input;
    assert.equal(
      (await f.request(path, body, { headers: { Authorization: undefined } })).status,
      401,
    );
    assert.equal(
      (await f.request(path, body, { headers: { Origin: 'https://foreign.invalid' } })).status,
      403,
    );
  }
  assert.equal(
    (await f.request(BASE + '/save', input, { headers: { Origin: undefined } })).status,
    403,
  );
  assert.equal(
    (await f.request(BASE + '/save', input, { headers: { 'Content-Type': 'text/plain' } })).status,
    415,
  );
  for (const body of [
    { ...input, classes: CLASSES },
    { ...input, expected: EXPECTED },
    { ...input, path: f.file },
    { ...input, command: 'PRIVATE_CASE_COMMAND' },
    { ...input, acknowledgeSharedScope: false },
  ])
    assert.equal((await f.request(BASE + '/save', body)).status, 400);
  for (const raw of ['{"incidentId":"a","incidentId":"b"}', Buffer.from([0xff])])
    assert.equal((await f.request(BASE + '/save', {}, { raw })).status, 400);
  assert.equal((await f.request(BASE + '/save', {}, { raw: Buffer.alloc(4097, 'x') })).status, 413);
  await assert.rejects(access(f.storeFile));
  assert.equal(await readFile(f.file, 'utf8'), f.original);
});
