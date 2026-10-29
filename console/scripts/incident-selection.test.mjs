import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLog } from '../../packages/core/dist/index.js';
import { createIncidentService } from './incidents.mjs';
const NOW = new Date('2026-10-23T09:00:00.000Z');
async function fixture(t, extra = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-incident-selection-')));
  const home = join(root, 'state');
  await mkdir(home, { mode: 0o700 });
  const file = join(home, 'audit.jsonl');
  const service = createIncidentService({ home, now: () => NOW, ...extra });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  return { home, file, service, journal: new AuditLog(file, () => NOW) };
}
const input = (extra = {}) => ({
  sessionId: 'private-session',
  phase: 'pre',
  tool: 'Bash',
  summary: 'private input stays internal',
  classes: ['shell.network'],
  decision: { effect: 'deny', ruleId: 'private-rule', reason: 'private reason' },
  ...extra,
});
const request = (incident) => ({ id: incident.id, expectedEvidenceSha: incident.evidenceSha });

test('comparison selector binds one exact visible record and permits unrelated appends', async (t) => {
  const { service, journal } = await fixture(t);
  await journal.append(input());
  const [incident] = (await service.read()).incidents;
  assert.equal(
    (await service.selectForComparison(request(incident))).summary,
    'private input stays internal',
  );
  await journal.append(input({ decision: { effect: 'allow', reason: 'not a finding' } }));
  assert.deepEqual((await service.selectForComparison(request(incident))).classes, [
    'shell.network',
  ]);
  await assert.rejects(
    service.selectForComparison({ ...request(incident), path: '/outside' }),
    /invalid-request/,
  );
  await assert.rejects(
    service.selectForComparison({ ...request(incident), expectedEvidenceSha: '0'.repeat(64) }),
    /invalid-request/,
  );
});

test('rewritten or partial records cannot retain the previous evidence identity', async (t) => {
  const { service, journal, file } = await fixture(t);
  await journal.append(input());
  const [incident] = (await service.read()).incidents;
  const bytes = await readFile(file, 'utf8');
  await writeFile(file, bytes.trimEnd(), { mode: 0o600 });
  await assert.rejects(service.selectForComparison(request(incident)), /stale-evidence/);
  await writeFile(file, bytes.replace('shell.network', 'shell.destructive'), { mode: 0o600 });
  await assert.rejects(service.selectForComparison(request(incident)), /stale-evidence/);
});

test('selection shares the 500-item visibility window rather than searching hidden history', async (t) => {
  const { service, journal, file } = await fixture(t);
  await journal.append(input());
  const [incident] = (await service.read()).incidents;
  const raw = (await readFile(file, 'utf8')).trim();
  const first = JSON.parse(raw);
  const rows = Array.from({ length: 501 }, (_, index) =>
    index === 0
      ? raw
      : JSON.stringify({ ...first, seq: index + 1, hash: index.toString(16).padStart(64, '0') }),
  );
  await writeFile(file, `${rows.join('\n')}\n`, { mode: 0o600 });
  const queue = await service.read();
  assert.equal(queue.incidents.length, 500);
  await assert.rejects(service.selectForComparison(request(incident)), /stale-evidence/);
  const visible = queue.incidents[0];
  assert.equal((await service.selectForComparison(request(visible))).seq, 501);
});
