import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AuditLog } from '../../packages/core/dist/index.js';
import { startServer } from './serve.mjs';

const PATH = '/api/incidents/compare';
const PRIVATE = [
  'PRIVATE_SESSION',
  'PRIVATE_COMMAND_VALUE',
  'PRIVATE_RULE_ID',
  'PRIVATE_POLICY_REASON',
];
const policyText = `version: 1\ndefault: allow\nrules:\n  - id: PRIVATE_RULE_ID\n    effect: deny\n    reason: PRIVATE_POLICY_REASON\n    when:\n      classes: [shell.network]\n      taint: suspect\n`;
const input = (extra = {}) => ({
  sessionId: 'PRIVATE_SESSION',
  phase: 'pre',
  tool: 'Bash',
  summary: 'PRIVATE_COMMAND_VALUE',
  classes: ['shell.network'],
  decision: { effect: 'deny', ruleId: 'PRIVATE_RULE_ID', reason: 'PRIVATE_POLICY_REASON' },
  ...extra,
});

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-comparison-http-')));
  let app;
  t.after(async () => {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  });
  const userHome = join(dir, 'user');
  const home = join(userHome, '.stroq');
  const project = join(dir, 'project');
  const root = join(dir, 'out');
  await Promise.all([mkdir(userHome), mkdir(project), mkdir(root)]);
  await mkdir(home, { mode: 0o700 });
  await writeFile(join(root, 'index.html'), 'fixture');
  await writeFile(join(home, 'policy.yaml'), policyText, { mode: 0o600 });
  const file = join(home, 'audit.jsonl');
  const journal = new AuditLog(file);
  await journal.append(input());
  app = await startServer({ home, userHome, project, root, port: 0 });
  const origin = app.url.split('/#')[0];
  async function request(path, body, options = {}) {
    const headers = {
      Authorization: `Bearer ${app.token}`,
      Origin: origin,
      'Content-Type': 'application/json',
      ...options.headers,
    };
    for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
    const response = await fetch(origin + path, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body: options.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  const queue = (await request('/api/incidents')).body;
  const item = queue.incidents[0];
  const bound = { id: item.id, expectedEvidenceSha: item.evidenceSha };
  return { home, file, journal, request, item, bound };
}

test('incident comparison HTTP action enforces authentication, origin, JSON, bounds and closed inputs', async (t) => {
  const { request, bound, home } = await fixture(t);
  assert.equal((await request(PATH)).status, 405);
  assert.equal(
    (await request(PATH, bound, { headers: { Authorization: 'Bearer wrong' } })).status,
    401,
  );
  assert.equal((await request(PATH, bound, { headers: { Authorization: undefined } })).status, 401);
  for (const headers of [
    { Origin: 'https://untrusted.invalid' },
    { Origin: undefined },
    { 'Sec-Fetch-Site': 'cross-site' },
  ])
    assert.equal((await request(PATH, bound, { headers })).status, 403);
  for (const headers of [
    { 'Content-Type': 'text/plain' },
    { 'Content-Type': undefined },
    { 'Content-Encoding': 'gzip' },
  ])
    assert.equal((await request(PATH, bound, { headers })).status, 415);
  assert.equal((await request(PATH, { padding: 'x'.repeat(4097) })).status, 413);
  for (const body of [
    null,
    [],
    {},
    { ...bound, path: '/outside-user-profile' },
    { ...bound, command: 'never execute' },
    { ...bound, expectedEvidenceSha: 'not-a-hash' },
    { ...bound, id: `incident-${'a'.repeat(64)}` },
  ])
    assert.equal((await request(PATH, body)).status, 400);
  assert.equal((await request(PATH, {}, { raw: '{invalid' })).status, 400);
  assert.equal((await request(PATH, {}, { raw: Buffer.from([0xc3, 0x28]) })).status, 400);
  assert.deepEqual((await readdir(home)).sort(), ['audit.jsonl', 'policy.yaml']);
});

test('real HTTP comparison passes the exact browser schema without private strings or review mutation', async (t) => {
  const schemas = await import('../.local-engine/local-api-schema.js');
  const { request, bound, home, file, item, journal } = await fixture(t);
  const auditBefore = await readFile(file, 'utf8');
  for (const value of PRIVATE) assert.equal(auditBefore.includes(value), true);
  const response = await request(PATH, bound);
  assert.equal(response.status, 200);
  assert.equal(schemas.validateIncidentComparison(response.body), true);
  assert.equal(response.body.incidentId, item.id);
  assert.equal(response.body.evidenceSha, item.evidenceSha);
  assert.deepEqual(response.body.classes, ['shell.network']);
  assert.equal(response.body.previousEffect, 'deny');
  assert.equal(response.body.relation, 'mixed');
  assert.deepEqual(
    response.body.scenarios.map((scenario) => [scenario.taint, scenario.effect]),
    [
      ['none', 'allow'],
      ['suspect', 'deny'],
    ],
  );
  const encoded = JSON.stringify(response.body);
  for (const value of [...PRIVATE, home, file]) assert.equal(encoded.includes(value), false);
  assert.equal(await readFile(file, 'utf8'), auditBefore);
  assert.equal(await readFile(join(home, 'policy.yaml'), 'utf8'), policyText);
  const current = (await request('/api/incidents')).body.incidents[0];
  assert.equal(current.status, 'open');
  assert.equal(current.reviewedAt, null);
  assert.deepEqual((await readdir(home)).sort(), ['audit.jsonl', 'policy.yaml']);
  await journal.append(input({ classes: ['fs.secrets'] }));
  const afterAppend = await request(PATH, bound);
  assert.equal(afterAppend.status, 200);
  assert.equal(schemas.validateIncidentComparison(afterAppend.body), true);
  assert.equal(afterAppend.body.evidenceSha, item.evidenceSha);
  assert.deepEqual((await readdir(home)).sort(), ['audit.jsonl', 'policy.yaml']);
});

test('HTTP comparison refuses unsupported content flags, unknown classes and stale captured evidence', async (t) => {
  const { request, bound, journal, file, home } = await fixture(t);
  await journal.append(input({ classes: ['shell.network', 'unrecognised.class'] }));
  const unknown = (await request('/api/incidents')).body.incidents[0];
  const unknownResponse = await request(PATH, {
    id: unknown.id,
    expectedEvidenceSha: unknown.evidenceSha,
  });
  assert.equal(unknownResponse.status, 422);
  assert.deepEqual(unknownResponse.body, { error: 'unsupported-evidence' });
  await journal.append(
    input({
      phase: 'post',
      scan: { verdict: 'suspect', score: 0.9, ruleIds: ['PRIVATE_RULE_ID'] },
    }),
  );
  const flag = (await request('/api/incidents')).body.incidents[0];
  assert.equal(flag.kind, 'content-flag');
  const flagResponse = await request(PATH, { id: flag.id, expectedEvidenceSha: flag.evidenceSha });
  assert.equal(flagResponse.status, 422);
  assert.deepEqual(flagResponse.body, { error: 'unsupported-evidence' });
  await writeFile(
    file,
    (await readFile(file, 'utf8')).replace('PRIVATE_COMMAND_VALUE', 'CHANGED_RECORDED_INPUT'),
  );
  const stale = await request(PATH, bound);
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body, { error: 'stale-evidence' });
  assert.deepEqual((await readdir(home)).sort(), ['audit.jsonl', 'policy.yaml']);
});

test('comparison preserves an existing manual review and does not rewrite its stored acknowledgement', async (t) => {
  const { request, bound, home } = await fixture(t);
  assert.equal(
    (await request('/api/incidents/review', { ...bound, status: 'reviewed' })).status,
    200,
  );
  const beforeReview = (await request('/api/incidents')).body.incidents[0];
  const file = join(home, 'console', 'incident-reviews.json');
  const bytes = await readFile(file);
  const info = await lstat(file, { bigint: true });
  const files = await readdir(join(home, 'console'));
  assert.equal((await request(PATH, bound)).status, 200);
  const afterReview = (await request('/api/incidents')).body.incidents[0];
  assert.equal(afterReview.status, 'reviewed');
  assert.equal(afterReview.reviewedAt, beforeReview.reviewedAt);
  assert.deepEqual(await readFile(file), bytes);
  const after = await lstat(file, { bigint: true });
  assert.equal(after.ino, info.ino);
  assert.equal(after.mtimeNs, info.mtimeNs);
  assert.equal(after.ctimeNs, info.ctimeNs);
  assert.deepEqual(await readdir(join(home, 'console')), files);
});
