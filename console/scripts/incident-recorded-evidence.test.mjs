import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
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
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLog } from '../../packages/core/dist/index.js';
import { createIncidentService } from './incidents.mjs';

const NOW = new Date('2026-10-26T10:00:00.000Z');
const privateValue = 'PRIVATE_RECORDED_EVIDENCE_SENTINEL';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const input = (extra) => ({
  sessionId: privateValue,
  phase: 'pre',
  tool: privateValue,
  summary: privateValue,
  classes: ['shell.network', 'origin.suspect'],
  decision: { effect: 'deny', ruleId: privateValue, reason: privateValue },
  ...extra,
});
const origin = (extra) => ({
  kind: 'url',
  suspect: true,
  at: NOW.toISOString(),
  source: privateValue,
  tool: privateValue,
  excerpt: privateValue,
  ...extra,
});
const request = (row) => ({ id: row.id, expectedEvidenceSha: row.evidenceSha });
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-recorded-evidence-')));
  const home = join(root, 'state');
  await mkdir(home, { mode: 0o700 });
  const file = join(home, 'audit.jsonl');
  const service = createIncidentService({ home, now: () => NOW, ...options });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  return { home, file, service, journal: new AuditLog(file, () => NOW) };
}

test('exact recorded classes, scope and origins are projected without any private field', async (t) => {
  const { file, home, service, journal } = await fixture(t);
  await journal.append(
    input({
      scope: { ruleId: privateValue, kind: 'scope', fingerprint: 'a'.repeat(64) },
      provenance: [origin({}), origin({ suspect: false }), origin({ kind: 'host' })],
      provenanceIncomplete: [{ kind: 'digest', excerpt: privateValue }],
      secrets: [{ name: privateValue, source: privateValue, canary: true }],
    }),
  );
  const [row] = (await service.read()).incidents;
  const before = await readFile(file);
  const report = await service.explain(request(row));
  assert.equal(report.schema, 'stroq-incident-recorded-evidence/1');
  assert.deepEqual(report.binding, {
    id: row.id,
    evidenceSha: row.evidenceSha,
    sequence: row.sequence,
    recordedAt: row.recordedAt,
    kind: row.kind,
  });
  assert.equal(report.effect, 'deny');
  assert.deepEqual(report.classes, {
    status: 'recorded',
    values: ['shell.network', 'origin.suspect'],
    omitted: 0,
  });
  assert.deepEqual(report.scope, { status: 'recorded', kind: 'scope' });
  assert.deepEqual(report.provenance, {
    status: 'recorded',
    values: [
      { kind: 'url', count: 2, suspect: 1 },
      { kind: 'host', count: 1, suspect: 1 },
    ],
    omitted: 0,
  });
  assert.deepEqual(report.provenanceIncomplete, {
    status: 'recorded',
    values: [{ kind: 'digest', count: 1 }],
    omitted: 0,
  });
  assert.equal(report.scan, null);
  assert.equal(JSON.stringify(report).includes(privateValue), false);
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readdir(home), ['audit.jsonl']);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
});

test('missing, valid empty, malformed and partially understood evidence stay distinct', async (t) => {
  const { service, journal } = await fixture(t);
  for (const classes of [undefined, [], null, ['shell.network', privateValue]]) {
    const entry = input({ classes });
    if (classes === undefined) delete entry.classes;
    await journal.append(entry);
    const [row] = (await service.read()).incidents;
    const report = await service.explain(request(row));
    const expected =
      classes === undefined
        ? 'not-recorded'
        : classes === null
          ? 'unavailable'
          : classes.length === 0
            ? 'recorded'
            : 'partial';
    assert.equal(report.classes.status, expected);
    assert.deepEqual(report.provenance, { status: 'not-recorded', values: [], omitted: 0 });
    assert.equal(JSON.stringify(report).includes(privateValue), false);
  }
  await journal.append(
    input({
      scope: { kind: 'scope' },
      provenance: [origin({}), origin({ suspect: 'true' }), origin({ kind: privateValue })],
      provenanceIncomplete: null,
    }),
  );
  const report = await service.explain(request((await service.read()).incidents[0]));
  assert.equal(report.scope.status, 'unavailable');
  assert.deepEqual(report.provenance, {
    status: 'partial',
    values: [{ kind: 'url', count: 1, suspect: 1 }],
    omitted: 2,
  });
  assert.deepEqual(report.provenanceIncomplete, { status: 'unavailable', values: [], omitted: 0 });
});

test('each input collection inspects at most 128 entries and counts later entries as omitted', async (t) => {
  const { service, journal } = await fixture(t);
  await journal.append(
    input({
      classes: [...Array(128).fill('shell.network'), privateValue],
      provenance: [...Array.from({ length: 128 }, () => origin({})), origin({ kind: 'host' })],
      provenanceIncomplete: [
        ...Array.from({ length: 128 }, () => ({ kind: 'encoded', excerpt: privateValue })),
        { kind: 'url', excerpt: privateValue },
      ],
    }),
  );
  const report = await service.explain(request((await service.read()).incidents[0]));
  assert.deepEqual(report.classes, { status: 'partial', values: ['shell.network'], omitted: 1 });
  assert.deepEqual(report.provenance, {
    status: 'partial',
    values: [{ kind: 'url', count: 128, suspect: 128 }],
    omitted: 1,
  });
  assert.deepEqual(report.provenanceIncomplete, {
    status: 'partial',
    values: [{ kind: 'encoded', count: 128 }],
    omitted: 1,
  });
});

test('post scan retains only score and explicit trust exemption; absence does not infer false', async (t) => {
  const { service, journal } = await fixture(t);
  for (const trusted of [undefined, true, false, privateValue]) {
    const scan = {
      verdict: 'suspect',
      score: 0.8,
      ruleIds: [privateValue],
      ...(trusted === undefined ? {} : { trusted }),
    };
    await journal.append(input({ phase: 'post', scan }));
    const report = await service.explain(request((await service.read()).incidents[0]));
    assert.equal(report.effect, null);
    assert.deepEqual(
      report.scan,
      trusted === privateValue
        ? { status: 'unavailable', score: null, trusted: null }
        : { status: 'recorded', score: 0.8, trusted: trusted ?? null },
    );
    assert.equal(JSON.stringify(report).includes(privateValue), false);
  }
});

test('exact request and bounded window refuse stale, hidden, partial or ambiguous raw records', async (t) => {
  const { service, journal, file } = await fixture(t);
  await journal.append(input({}));
  const [row] = (await service.read()).incidents;
  await assert.rejects(service.explain({ ...request(row), path: '/outside' }), /invalid-request/);
  await assert.rejects(
    service.explain({ ...request(row), expectedEvidenceSha: '0'.repeat(64) }),
    /invalid-request/,
  );
  await journal.append(
    input({ decision: { effect: 'allow', ruleId: null, reason: privateValue } }),
  );
  assert.equal((await service.explain(request(row))).binding.id, row.id);
  const bytes = await readFile(file, 'utf8');
  await writeFile(file, bytes.replace('shell.network', 'shell.destructive'));
  await assert.rejects(service.explain(request(row)), /stale-evidence/);
  const raw = bytes.split('\n')[0];
  const duplicated = raw.replace('"decision":', '"decision":{"effect":"allow"},"decision":');
  await writeFile(file, duplicated + '\n');
  await assert.rejects(
    service.explain({ id: `incident-${hash(duplicated)}`, expectedEvidenceSha: hash(duplicated) }),
    /unsupported-evidence/,
  );
  const nestedDuplicate = raw.replace('"effect":"deny"', '"effect":"allow","\\u0065ffect":"deny"');
  await writeFile(file, nestedDuplicate + '\n');
  await assert.rejects(
    service.explain({
      id: `incident-${hash(nestedDuplicate)}`,
      expectedEvidenceSha: hash(nestedDuplicate),
    }),
    /unsupported-evidence/,
  );
  await writeFile(file, raw);
  await assert.rejects(service.explain(request(row)), /stale-evidence/);
});

test('truncated and omitted captures remain explicit; selection never falls back by sequence', async (t) => {
  const { service, journal, file } = await fixture(t, { maxReadBytes: 2048 });
  await journal.append(input({}));
  const [row] = (await service.read()).incidents;
  const raw = (await readFile(file, 'utf8')).trim();
  await writeFile(file, `${'x'.repeat(3000)}\nnot-json\n${raw}\n`);
  const report = await service.explain(request(row));
  assert.deepEqual(report.window, { truncated: true, omitted: 1 });
  const changed = raw.replace('"deny"', '"ask"');
  await writeFile(file, `${changed}\n`);
  await assert.rejects(service.explain(request(row)), /stale-evidence/);
  await service.close();
  await assert.rejects(service.explain(request(row)), /server-stopped/);
});

test('raw evidence parser rejects depth/node excess without adopting or rewriting source', async (t) => {
  const { service, journal, file } = await fixture(t);
  await journal.append(input({}));
  const raw = (await readFile(file, 'utf8')).trim();
  for (const extra of [
    '['.repeat(34) + 'null' + ']'.repeat(34),
    '[' + Array(65536).fill('0').join(',') + ']',
  ]) {
    const changed = raw.slice(0, -1) + ',"unknown":' + extra + '}';
    await writeFile(file, changed + '\n');
    const expectedEvidenceSha = hash(changed);
    await assert.rejects(
      service.explain({ id: `incident-${expectedEvidenceSha}`, expectedEvidenceSha }),
      /unsupported-evidence/,
    );
    assert.equal(await readFile(file, 'utf8'), changed + '\n');
  }
});
