import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readLocalSnapshot } from './local-snapshot.mjs';
import { createIncidentService } from './incidents.mjs';

const NOW = new Date('2026-10-23T09:00:00.000Z');
const entry = (overrides = {}) => ({
  seq: 1,
  ts: NOW.toISOString(),
  phase: 'pre',
  sessionId: 'private-session',
  tool: 'Bash',
  summary: 'credential=PRIVATE_SENTINEL',
  decision: { effect: 'deny', ruleId: 'PRIVATE_SENTINEL', reason: 'PRIVATE_SENTINEL' },
  ...overrides,
});
const proof = (overrides = {}) => ({
  version: 1,
  agent: 'claude-code',
  mode: 'live',
  hostVersion: 'PRIVATE_SENTINEL',
  stroqVersion: '0.1',
  policySha256: 'a'.repeat(64),
  at: NOW.toISOString(),
  state: 'verified',
  caveats: [],
  probes: [
    {
      id: 'allow',
      kind: 'allow',
      mark: 'passed',
      evidence: { E1: true, E2: true, E3: true, E4: null },
    },
    {
      id: 'deny',
      kind: 'deny',
      mark: 'passed',
      evidence: { E1: true, E2: true, E3: true, E4: true },
    },
    {
      id: 'deny:control',
      kind: 'deny',
      mark: 'passed',
      evidence: { E1: true, E2: null, E3: true, E4: null },
    },
  ],
  ...overrides,
});

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'stroq-console-data-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('empty home gives no invented calls, hosts, or credentials', async (t) => {
  const result = await readLocalSnapshot({ home: await fixture(t), now: NOW });
  assert.equal(result.schema, 'stroq-console/1');
  assert.equal(result.source, 'local');
  assert.deepEqual(result.calls, []);
  assert.deepEqual(result.agents, []);
  assert.deepEqual(result.keys, []);
});

test('snapshot binds only supported hash-bearing raw journal rows to the exact finding digest', async (t) => {
  const home = await realpath(await fixture(t));
  const raw = JSON.stringify(
    entry({
      hash: 'a'.repeat(64),
      prevHash: 'b'.repeat(64),
      summary: 'PRIVATE_SENTINEL_\u0442\u0435\u0441\u0442',
    }),
  );
  const expected = createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex');
  await writeFile(join(home, 'audit.jsonl'), raw + '\n');
  const snapshot = await readLocalSnapshot({ home, now: NOW });
  assert.equal(snapshot.calls[0].evidenceSha, expected);
  const service = createIncidentService({ home, now: () => NOW });
  const incidents = await service.read();
  assert.equal(incidents.incidents[0].id, `incident-${expected}`);
  assert.equal(incidents.incidents[0].evidenceSha, snapshot.calls[0].evidenceSha);
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_SENTINEL'));
});

test('raw whitespace and CRLF change the evidence binding even for equal parsed rows and sequences', async (t) => {
  const home = await fixture(t);
  const raw = JSON.stringify(entry({ hash: 'a'.repeat(64), prevHash: 'b'.repeat(64) }));
  const seen = [];
  for (const line of [raw, ' ' + raw, raw + '\r']) {
    await writeFile(join(home, 'audit.jsonl'), line + '\n');
    const snapshot = await readLocalSnapshot({ home, now: NOW });
    assert.equal(snapshot.calls[0].id, 'audit-1');
    assert.equal(snapshot.calls[0].evidenceSha, createHash('sha256').update(line).digest('hex'));
    seen.push(snapshot.calls[0].evidenceSha);
  }
  assert.equal(new Set(seen).size, 3);
});

test('legacy rows stay visible without manufacturing an exact binding from incomplete hash claims', async (t) => {
  const home = await fixture(t);
  for (const fields of [
    {},
    { hash: 'a'.repeat(64) },
    { hash: 'bad', prevHash: 'b'.repeat(64) },
    { hash: 'a'.repeat(64), prevHash: 'B'.repeat(64) },
  ]) {
    await writeFile(join(home, 'audit.jsonl'), JSON.stringify(entry(fields)) + '\n');
    const snapshot = await readLocalSnapshot({ home, now: NOW });
    assert.equal(snapshot.calls.length, 1);
    assert.equal(Object.hasOwn(snapshot.calls[0], 'evidenceSha'), false);
  }
});

test('audit projection never returns raw command, rule, host or session claims', async (t) => {
  const home = await fixture(t);
  await writeFile(
    join(home, 'audit.jsonl'),
    `${JSON.stringify(entry({ sessionId: 'PRIVATE_SENTINEL', agent: 'Claude Code', operation: 'PRIVATE_SENTINEL', secrets: [{ value: 'PRIVATE_SENTINEL' }] }))}\n`,
  );
  const result = await readLocalSnapshot({ home, now: NOW });
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].decision, 'block');
  assert.equal(result.calls[0].agent, 'Unknown host');
  assert.match(result.calls[0].sessionId, /^session-[a-f0-9]{16}$/);
  assert.equal(result.calls[0].date, '2026-10-23');
  assert.equal(result.calls[0].time, '09:00:00');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));
  assert.match(result.limitations.join(' '), /UTC/);
});

test('unknown outcomes, malformed timestamps and partial audit writes fail closed', async (t) => {
  const home = await fixture(t);
  const rows = [
    entry({ decision: { effect: 'approved' } }),
    entry({ ts: '2026-02-31T09:00:00.000Z' }),
    entry({ outcome: 'failed' }),
    entry({ seq: -1 }),
    entry({ phase: 'post', decision: undefined, scan: { verdict: 'dangerous' } }),
  ];
  await writeFile(
    join(home, 'audit.jsonl'),
    `${rows.map(JSON.stringify).join('\n')}\n{bad json}\n${JSON.stringify(entry())}`,
  );
  const result = await readLocalSnapshot({ home, now: NOW });
  assert.deepEqual(result.calls, []);
  assert.match(result.limitations.join(' '), /unreadable|unsupported|incomplete/);
});

test('scan observations never become execution allows', async (t) => {
  const home = await fixture(t);
  const rows = ['clean', 'suspect'].map((verdict, i) =>
    entry({
      seq: i + 1,
      phase: 'post',
      decision: undefined,
      scan: { verdict, score: 0.7, ruleIds: ['PRIVATE_SENTINEL'] },
    }),
  );
  await writeFile(join(home, 'audit.jsonl'), `${rows.map(JSON.stringify).join('\n')}\n`);
  const result = await readLocalSnapshot({ home, now: NOW });
  assert.deepEqual(
    result.calls.map((row) => row.decision),
    ['flag'],
  );
  assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));
});

test('historical proof and hook stamps never assert current protection', async (t) => {
  const home = await fixture(t);
  await mkdir(join(home, 'last-hook'));
  await mkdir(join(home, 'live'));
  await writeFile(join(home, 'last-hook', 'claude-code'), `${NOW.toISOString()}\n`);
  await writeFile(join(home, 'live', 'claude-code.json'), JSON.stringify(proof()));
  const result = await readLocalSnapshot({ home, now: NOW });
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].state, 'unver');
  assert.deepEqual(result.agents[0].checks, ['na', 'yes', 'yes', 'na']);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));
});

test('forged verified claims and stand-ins are not protection evidence', async (t) => {
  const home = await fixture(t);
  await mkdir(join(home, 'live'));
  const noControl = proof();
  noControl.probes.pop();
  const noHookWords = proof();
  noHookWords.probes[1].evidence.E4 = false;
  for (const invalid of [
    proof({ probes: [] }),
    noControl,
    noHookWords,
    proof({ mode: 'stand-in' }),
    proof({ state: 'unsupported' }),
    proof({ at: '2099-01-01T00:00:00.000Z' }),
    proof({ unexpected: true }),
  ]) {
    await writeFile(join(home, 'live', 'claude-code.json'), JSON.stringify(invalid));
    const result = await readLocalSnapshot({ home, now: NOW });
    assert.deepEqual(result.agents, []);
  }
});

test('a recorded failed proof remains visible as historical failure', async (t) => {
  const home = await fixture(t);
  await mkdir(join(home, 'live'));
  const failed = proof();
  failed.state = 'failed';
  failed.probes[1].mark = 'failed';
  await writeFile(join(home, 'live', 'claude-code.json'), JSON.stringify(failed));
  const result = await readLocalSnapshot({ home, now: NOW });
  assert.equal(result.agents[0].state, 'unver');
  assert.equal(result.agents[0].checks[2], 'no');
  assert.match(result.limitations.join(' '), /stored live test recorded a failure/);
});

test('invalid and future hook stamps do not become observed hosts', async (t) => {
  const home = await fixture(t);
  await mkdir(join(home, 'last-hook'));
  for (const stamp of ['1', '2026-02-31T00:00:00.000Z', '2099-01-01T00:00:00.000Z']) {
    await writeFile(join(home, 'last-hook', 'claude-code'), stamp);
    assert.deepEqual((await readLocalSnapshot({ home, now: NOW })).agents, []);
  }
});

test('symlinked audit and directories, oversized proof and invalid stamps are refused', async (t) => {
  const home = await fixture(t);
  const other = await fixture(t);
  await writeFile(join(other, 'private'), `${JSON.stringify(entry())}\n`);
  await symlink(join(other, 'private'), join(home, 'audit.jsonl'));
  await symlink(other, join(home, 'last-hook'));
  await mkdir(join(home, 'live'));
  await writeFile(join(home, 'live', 'claude-code.json'), ' '.repeat(70 * 1024));
  await writeFile(join(other, 'claude-code'), NOW.toISOString());
  const result = await readLocalSnapshot({ home, now: NOW });
  assert.deepEqual(result.calls, []);
  assert.deepEqual(result.agents, []);
});

test('audit tail is bounded and unrecognized post records are omitted', async (t) => {
  const home = await fixture(t);
  await writeFile(
    join(home, 'audit.jsonl'),
    `${'x'.repeat(2 * 1024 * 1024)}\n${JSON.stringify(entry())}\n`,
  );
  const result = await readLocalSnapshot({ home, now: NOW });
  assert.equal(result.calls.length, 1);
  assert.match(result.limitations.join(' '), /tail/);
});
