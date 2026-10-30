import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tsImport } from 'tsx/esm/api';
const loader = await mkdtemp(join(tmpdir(), 'stroq-governance-lease-loader-'));
after(() => rm(loader, { recursive: true, force: true }));
const tsconfig = join(loader, 'tsconfig.json');
await writeFile(
  tsconfig,
  JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
  }),
);
const source = new URL('./mcp-governance-store.ts', import.meta.url).href;
const { createMcpGovernanceStore } = await tsImport(source, {
  parentURL: import.meta.url,
  tsconfig,
});
const sha = 'a'.repeat(64),
  id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-governance-lease-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  await mkdir(home, { mode: 0o700 });
  const options = {
    home,
    contextId: 'governance-context-' + sha,
    workspaceId: 'workspace-' + sha.slice(0, 24),
  };
  return {
    base,
    home,
    options,
    a: createMcpGovernanceStore(options),
    b: createMcpGovernanceStore(options),
    lock: join(home, 'mcp-governance', '.writer.lock'),
  };
}

test('two real controllers serialize writers while passive reads do not rewrite live owner metadata', async (t) => {
  const f = await fixture(t);
  let enter, release, retained;
  const entered = new Promise((r) => (enter = r)),
    gate = new Promise((r) => (release = r));
  const a = f.a.withLease({ operationId: id(1) }, async (lease) => {
    retained = lease;
    enter();
    await gate;
    await lease.assertCurrent();
  });
  await entered;
  const owner = await readFile(join(f.lock, 'owner.json'));
  assert.equal((await f.b.read()).status, 'ready');
  assert.deepEqual(await readFile(join(f.lock, 'owner.json')), owner);
  await assert.rejects(
    f.b.withLease({ operationId: id(2), explicitRecovery: true }, async () => {}),
    /mcp-governance-busy/,
  );
  release();
  await a;
  await assert.rejects(retained.assertCurrent(), /mcp-governance-invalid/);
  assert.equal((await readdir(join(f.home, 'mcp-governance'))).includes('.writer.lock'), false);
  await f.b.withLease({ operationId: id(2) }, (lease) => lease.assertCurrent());
});

test('actual dead child owner is never repaired by GET or ordinary admission; explicit recovery claims only its pinned lease', async (t) => {
  const f = await fixture(t);
  const program = `import {tsImport} from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};
    const {createMcpGovernanceStore}=await tsImport(${JSON.stringify(source)},{parentURL:${JSON.stringify(import.meta.url)},tsconfig:${JSON.stringify(tsconfig)}});
    const store=createMcpGovernanceStore(${JSON.stringify(f.options)});
    await store.withLease({operationId:${JSON.stringify(id(1))}},async lease=>{await lease.assertCurrent();process.stdout.write('held\\n');await new Promise(()=>{});});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d.toString()));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('owned child lease timeout: ' + stderr)), 10000);
    child.once('error', reject);
    child.once('exit', () => {
      clearTimeout(timer);
      reject(Error('owned child exited: ' + stderr));
    });
    child.stdout.once('data', (d) => {
      clearTimeout(timer);
      assert.equal(d.toString(), 'held\n');
      resolve();
    });
  });
  const owner = await readFile(join(f.lock, 'owner.json'));
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  assert.equal((await f.b.read()).status, 'ready');
  assert.deepEqual(await readFile(join(f.lock, 'owner.json')), owner);
  await assert.rejects(
    f.b.withLease({ operationId: id(2) }, async () => {}),
    /mcp-governance-busy/,
  );
  assert.deepEqual(await readFile(join(f.lock, 'owner.json')), owner);
  await f.b.withLease({ operationId: id(2), explicitRecovery: true }, (lease) =>
    lease.assertCurrent(),
  );
  assert.equal((await readdir(join(f.home, 'mcp-governance'))).includes('.writer.lock'), false);
});

test('malformed owner/orphan lock cannot be guessed dead or automatically deleted', async (t) => {
  const f = await fixture(t),
    dir = join(f.home, 'mcp-governance');
  await mkdir(dir, { mode: 0o700 });
  await mkdir(f.lock, { mode: 0o700 });
  await writeFile(join(f.lock, 'owner.json'), 'unknown owner', { mode: 0o600 });
  assert.equal((await f.a.read()).status, 'unavailable');
  await assert.rejects(
    f.a.withLease({ operationId: id(1), explicitRecovery: true }, async () => {}),
    /mcp-governance-store-unavailable/,
  );
  assert.equal(await readFile(join(f.lock, 'owner.json'), 'utf8'), 'unknown owner');
});

test('replacement owner bytes during custody are preserved and refuse publication and cleanup', async (t) => {
  const f = await fixture(t);
  let replacement;
  await assert.rejects(
    f.a.withLease({ operationId: id(1) }, async (lease) => {
      const owner = JSON.parse(await readFile(join(f.lock, 'owner.json'), 'utf8'));
      replacement = JSON.stringify({ ...owner, token: id(99) });
      await writeFile(join(f.lock, 'owner.json'), replacement);
      await lease.assertCurrent();
    }),
    /mcp-governance-store-unavailable/,
  );
  assert.equal(await readFile(join(f.lock, 'owner.json'), 'utf8'), replacement);
});

test('the caller retains its private failure identity after verified lease release', async (t) => {
  const f = await fixture(t),
    refusal = Error('stale-policy');
  await assert.rejects(
    f.a.withLease({ operationId: id(1) }, async () => {
      throw refusal;
    }),
    (error) => error === refusal,
  );
  assert.equal((await readdir(join(f.home, 'mcp-governance'))).includes('.writer.lock'), false);
});
