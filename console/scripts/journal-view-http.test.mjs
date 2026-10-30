import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AuditLog } from '../../packages/core/dist/index.js';
import { startServer } from './serve.mjs';

const schemas = await import('../.local-engine/local-api-schema.js');
const NOW = new Date('2026-10-27T10:00:00.000Z');

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-journal-http-')));
  await mkdir(join(dir, 'out'));
  const home = join(dir, 'home');
  await mkdir(home, { mode: 0o700 });
  await writeFile(join(dir, 'out', 'index.html'), 'x');
  const app = await startServer({
    root: join(dir, 'out'),
    home,
    userHome: home,
    project: dir,
    port: 0,
  });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const origin = app.url.split('/#')[0];
  const call = (path, { method = 'GET', headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: app.server.address().port,
          path,
          method,
          headers: { authorization: `Bearer ${app.token}`, ...headers },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  const tail = (payload, extra = {}) =>
    call('/api/journal/tail', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...extra },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });
  const log = new AuditLog(join(home, 'audit.jsonl'), () => NOW);
  return { app, dir, home, origin, call, tail, log };
}
const entry = (tool, effect) => ({
  sessionId: 'private-session',
  phase: 'pre',
  tool,
  summary: 'private summary',
  classes: effect === 'deny' ? ['shell.network'] : [],
  decision: {
    effect,
    ruleId: effect === 'deny' ? 'deny-encoded-exec' : null,
    reason: 'private reason',
  },
});

test('summary and tail answer with the closed schema over the real server', async (t) => {
  const { call, tail, log } = await fixture(t);
  await log.append(entry('Read', 'allow'));
  await log.append(entry('Bash', 'deny'));
  const summary = await call('/api/journal/summary');
  assert.equal(summary.status, 200);
  const sum = JSON.parse(summary.text);
  assert.equal(schemas.validateJournalSummary(sum), true);
  assert.deepEqual(sum.counts, { allow: 1, ask: 0, deny: 1, suspect: 0 });
  const first = await tail({ after: null });
  assert.equal(first.status, 200);
  const body = JSON.parse(first.text);
  assert.equal(schemas.validateJournalTail(body), true);
  assert.deepEqual(
    body.rows.map((r) => [r.seq, r.tool, r.decision, r.ruleId]),
    [
      [1, 'file-read', 'allow', null],
      [2, 'shell', 'deny', 'deny-encoded-exec'],
    ],
  );
  for (const text of [summary.text, first.text])
    for (const s of ['private summary', 'private reason', 'private-session'])
      assert.equal(text.includes(s), false, s);
  await log.append(entry('Edit', 'allow'));
  const nextResponse = await tail({ after: `${body.head.seq}.${body.head.lineSha}` });
  assert.equal(nextResponse.status, 200, nextResponse.text);
  const next = JSON.parse(nextResponse.text);
  assert.equal(next.cursor, 'ok');
  assert.deepEqual(
    next.rows.map((r) => r.seq),
    [3],
  );
});

test('a journal that is not there is a state, not an error', async (t) => {
  const { call, tail } = await fixture(t);
  assert.equal(JSON.parse((await call('/api/journal/summary')).text).state, 'missing');
  assert.equal(JSON.parse((await tail({ after: null })).text).state, 'missing');
});

test('only the closed reads are allowed, and only from the page that holds the token', async (t) => {
  const { call, tail, origin } = await fixture(t);
  assert.equal((await call('/api/journal/summary?since=1')).status, 400);
  assert.equal(
    (
      await call('/api/journal/summary', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
    405,
  );
  assert.equal(
    (
      await call('/api/journal/summary', {
        headers: { 'content-length': '2' },
        method: 'GET',
        body: '{}',
      })
    ).status,
    400,
  );
  assert.equal((await call('/api/journal/tail')).status, 405);
  assert.equal((await call('/api/journal/export')).status, 404);
  for (const bad of [
    {},
    { after: null, limit: 5000 },
    { after: `0.${'a'.repeat(64)}` },
    { after: { seq: 1, lineSha: 'a'.repeat(64) } },
    { path: '/etc/passwd' },
    '{broken',
    [],
  ])
    assert.equal((await tail(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await tail('x'.repeat(5000))).status, 413);
  assert.equal((await tail({ after: null }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal(
    (
      await call('/api/journal/tail', {
        method: 'POST',
        headers: { origin: 'https://attacker.invalid', 'content-type': 'application/json' },
        body: '{"after":null}',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call('/api/journal/tail', {
        method: 'POST',
        headers: { authorization: 'Bearer wrong', origin, 'content-type': 'application/json' },
        body: '{"after":null}',
      })
    ).status,
    401,
  );
});

test('reading the journal writes nothing under the Stroq home', async (t) => {
  const { call, tail, log, home } = await fixture(t);
  await log.append(entry('Read', 'allow'));
  const before = (await readdir(home)).sort();
  await call('/api/journal/summary');
  await tail({ after: null });
  assert.deepEqual((await readdir(home)).sort(), before);
});

test('since answers with the closed schema over the real server, and only as a closed read', async (t) => {
  const { call, log, origin } = await fixture(t);
  await log.append(entry('Bash', 'deny'));
  const post = (body, headers = {}) =>
    call('/api/journal/since', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const ok = await post({ since: '2026-10-27T09:00:00.000Z' });
  assert.equal(ok.status, 200, ok.text);
  const body = JSON.parse(ok.text);
  assert.equal(schemas.validateJournalSince(body), true, ok.text);
  assert.deepEqual(body.counts, { allow: 0, ask: 0, deny: 1, suspect: 0 });
  assert.equal((await call('/api/journal/since')).status, 405);
  for (const bad of [{}, { since: 'yesterday' }, { since: null, x: 1 }, '{broken', []])
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await post('x'.repeat(5000))).status, 413);
  assert.equal(
    (await post({ since: '2026-10-27T09:00:00.000Z' }, { 'content-type': 'text/plain' })).status,
    415,
  );
  assert.equal(
    (await post({ since: '2026-10-27T09:00:00.000Z' }, { origin: 'https://attacker.invalid' }))
      .status,
    403,
  );
});
