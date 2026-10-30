import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { fileURLToPath } from 'node:url';
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const loader = await mkdtemp(join(tmpdir(), 'stroq-call-observer-loader-'));
after(() => rm(loader, { recursive: true, force: true }));
const tsconfig = join(loader, 'tsconfig.json');
await writeFile(
  tsconfig,
  JSON.stringify({
    compilerOptions: {
      baseUrl: repositoryRoot,
      paths: { '@stroq/core': ['packages/core/src/index.ts'] },
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
    },
  }),
);
const imported = (p) => tsImport(p, { parentURL: import.meta.url, tsconfig });
const { readMcpCallControlObservation } = await imported('./mcp-call-control-observation.ts');
const { hashEntry } = await imported('../../packages/core/src/audit/audit-log.ts');
const controlId = '00000000-0000-4000-8000-000000000001',
  eventId = '00000000-0000-4000-8000-000000000002',
  invocationSha256 = 'a'.repeat(64),
  at = '2026-10-26T00:00:00.000Z',
  now = Date.parse(at) + 1000,
  current = { controlId, eventId, invocationSha256, mode: 'paused', at };
const row = (metadata = {}, fields = {}) => {
  const value = {
    seq: 1,
    ts: at,
    prevHash: '0'.repeat(64),
    phase: 'pre',
    decision: { effect: 'deny', ruleId: 'mcp-call-control-paused' },
    mcpCallControl: {
      controlId,
      eventId,
      invocationSha256,
      authoritySha256: 'b'.repeat(64),
      reason: 'paused',
      ...metadata,
    },
    ...fields,
  };
  return { ...value, hash: hashEntry(value) };
};
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-call-observer-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home, { mode: 0o700 });
  return { root, home, file: join(home, 'audit.jsonl') };
}
test('only a complete hash-verified exact control/event/invocation native refusal is projected', async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify(row()) + '\n', { mode: 0o600 });
  const observed = await readMcpCallControlObservation(f.home, current, now);
  assert.equal(observed.status, 'observed');
  assert.equal(observed.eventId, eventId);
  assert.deepEqual(
    Object.keys(observed).sort(),
    ['status', 'at', 'eventId', 'invocationSha256', 'reason'].sort(),
  );
  for (const metadata of [
    { eventId: '00000000-0000-4000-8000-000000000003' },
    { invocationSha256: 'c'.repeat(64) },
    { controlId: '00000000-0000-4000-8000-000000000004' },
  ]) {
    await writeFile(f.file, JSON.stringify(row(metadata)) + '\n', { mode: 0o600 });
    assert.equal((await readMcpCallControlObservation(f.home, current, now)).status, 'unobserved');
  }
  await writeFile(
    f.file,
    JSON.stringify({ ...row(), hash: 'd'.repeat(64) }) + '\n' + JSON.stringify(row()),
    { mode: 0o600 },
  );
  assert.equal((await readMcpCallControlObservation(f.home, current, now)).status, 'unobserved');
});
test('recorded pause stays separate from audit availability and never follows resume/new event', async (t) => {
  const f = await fixture(t);
  assert.equal((await readMcpCallControlObservation(f.home, current, now)).status, 'unobserved');
  await writeFile(f.file, JSON.stringify(row()) + '\n', { mode: 0o600 });
  assert.equal(
    (await readMcpCallControlObservation(f.home, { ...current, mode: 'enabled' }, now)).status,
    'unobserved',
  );
  assert.equal(
    (
      await readMcpCallControlObservation(
        f.home,
        { ...current, eventId: '00000000-0000-4000-8000-000000000005' },
        now,
      )
    ).status,
    'unobserved',
  );
  const other = join(f.root, 'other');
  await mkdir(other, { mode: 0o700 });
  await writeFile(join(other, 'audit.jsonl'), JSON.stringify(row()) + '\n', { mode: 0o600 });
  const linked = join(f.root, 'linked');
  await symlink(other, linked);
  assert.equal((await readMcpCallControlObservation(linked, current, now)).status, 'unavailable');
});
