import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  lstat,
  rm,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tsImport } from 'tsx/esm/api';
const { runCodexNetworkCheckEngine, verifyNetworkNative } = await tsImport(
  './codex-network-check-engine.ts',
  { parentURL: import.meta.url },
);
const { getSuiteSha, getProfileCopySha } = await tsImport('./codex-network-check-protocol.ts', {
  parentURL: import.meta.url,
});
const { validateCodexNetworkCheckResult } = await tsImport('../lib/codex-network-check.ts', {
  parentURL: import.meta.url,
});
const sha = (b) => createHash('sha256').update(b).digest('hex');
const pin = (s) =>
  Object.fromEntries(
    ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map((k) => [k, s[k]]),
  );
const rootPin = (path, s) => ({
  path,
  ...Object.fromEntries(['dev', 'ino', 'uid', 'mode'].map((k) => [k, s[k]])),
});
async function fixture(t, mode = 'deny') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-network-engine-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = join(root, 'native-fixture'),
    source = join(root, 'config.toml');
  await writeFile(source, 'owned\n', { mode: 0o600 });
  const body = `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const a=process.argv.slice(2),i=a.indexOf('--'),nonce=a[i+4];if(${JSON.stringify(mode)}==='allow'){const r=spawnSync(a[i+1],a.slice(i+2),{stdio:'inherit'});process.exit(r.status??1);}if(${JSON.stringify(mode)}==='hang')setInterval(()=>{},1000);else if(${JSON.stringify(mode)}==='bootstrap')process.exit(71);else if(${JSON.stringify(mode)}==='limit')process.stdout.write('x'.repeat(200000));else process.stdout.write(JSON.stringify({schema:'stroq-codex-network-canary/1',nonce,results:[{id:'tcp',attempted:true,code:'EPERM'},{id:'unix',attempted:true,code:${JSON.stringify(mode === 'partial' ? 'error' : 'EACCES')}}]}));\n`;
  await writeFile(native, body, { mode: 0o700 });
  const rootInfo = rootPin(root, await lstat(root)),
    binarySha = sha(body),
    profiles = { selected: { extends: ':workspace', network: { enabled: false } } };
  const input = {
    binding: {
      controlContextId: 'codex-context-' + 'a'.repeat(64),
      captureSha256: 'b'.repeat(64),
      configSha256: sha('owned\n'),
      runtimeSha256: 'c'.repeat(64),
      nativeBinarySha256: binarySha,
      sourceGraphSha256: 'd'.repeat(64),
    },
    kind: 'profile',
    profiles,
    selectedProfile: 'selected',
    native: {
      path: native,
      sha256: binarySha,
      file: pin(await lstat(native)),
      version: 'codex-cli 0.164.0-alpha.11.1',
      platform: 'darwin',
      parents: [rootInfo],
    },
    sourcePins: [
      {
        id: 'config-source-' + 'a'.repeat(24),
        scope: 'user',
        path: source,
        root: rootInfo,
        sha256: sha('owned\n'),
        file: pin(await lstat(source)),
        directories: [rootInfo],
      },
    ],
    networkOff: true,
    managedUnverified: true,
  };
  return {
    root,
    native,
    input,
    options: { platform: 'darwin', verifyNative: (n) => verifyNetworkNative(n, n.sha256) },
  };
}
async function gone(path) {
  await assert.rejects(lstat(path), (e) => e.code === 'ENOENT');
}
test('denial requires reached finite errno and real positive connections; scratch registered empty and removed before result', async (t) => {
  const f = await fixture(t),
    roots = [],
    live = new Set(),
    progress = [];
  const result = await runCodexNetworkCheckEngine(f.input, {
    ...f.options,
    onScratch: (s) => {
      roots.push(s);
      assert.equal(s.root.includes('stroq-console-net-'), true);
    },
    onChild: (p) => live.add(p),
    onChildClosed: (p) => live.delete(p),
    onProgress: (p) => progress.push(p),
    fault: async (stage, detail) => {
      if (stage === 'scratch-registered') assert.deepEqual(await readdir(detail.scratch.root), []);
    },
  });
  assert.equal(validateCodexNetworkCheckResult(result), true);
  assert.equal(result.outcome, 'passed');
  assert.equal(result.profileCopySha256, getProfileCopySha(f.input));
  assert.equal(result.suiteSha256, getSuiteSha());
  assert.deepEqual(
    result.checks.map((c) => [c.positiveConnections, c.effect, c.connections]),
    [
      [1, 'denied', 0],
      [1, 'denied', 0],
    ],
  );
  assert.deepEqual(progress, ['positive', 'native', 'cleanup']);
  assert.equal(live.size, 0);
  assert.equal(roots.length, 1);
  await gone(roots[0].root);
  assert.equal(JSON.stringify(result).includes(f.root), false);
});
test('native allowing the same canary is attention and keeps one listener connection for each transport', async (t) => {
  const f = await fixture(t, 'allow');
  const r = await runCodexNetworkCheckEngine(f.input, f.options);
  assert.equal(r.outcome, 'attention');
  assert.deepEqual(
    r.checks.map((c) => c.effect),
    ['allowed', 'allowed'],
  );
  assert.equal(validateCodexNetworkCheckResult(r), true);
});
test('native bootstrap or partial canary never becomes a passing block', async (t) => {
  for (const mode of ['bootstrap', 'partial']) {
    const f = await fixture(t, mode),
      r = await runCodexNetworkCheckEngine(f.input, f.options);
    assert.equal(r.outcome, 'inconclusive');
    assert.equal(validateCodexNetworkCheckResult(r), true);
    if (mode === 'bootstrap')
      assert.equal(
        r.checks.every((c) => c.effect === 'unreached'),
        true,
      );
  }
});
test('output cap and deadline kill groups and clean roots before rejecting', async (t) => {
  for (const [mode, error] of [
    ['limit', 'output-limit'],
    ['hang', 'deadline-exceeded'],
  ]) {
    const f = await fixture(t, mode),
      roots = [],
      live = new Set();
    await assert.rejects(
      runCodexNetworkCheckEngine(f.input, {
        ...f.options,
        deadlineMs: mode === 'hang' ? 200 : 12000,
        onScratch: (s) => roots.push(s),
        onChild: (p) => live.add(p),
        onChildClosed: (p) => live.delete(p),
      }),
      (e) => e.message === error,
    );
    assert.equal(live.size, 0);
    await gone(roots[0].root);
  }
});
test('cancellation and native pin drift never leave a running child or scratch', async (t) => {
  const f = await fixture(t, 'hang'),
    controller = new AbortController(),
    roots = [];
  await assert.rejects(
    runCodexNetworkCheckEngine(f.input, {
      ...f.options,
      signal: controller.signal,
      onScratch: (s) => roots.push(s),
      onProgress: (p) => {
        if (p === 'native') setTimeout(() => controller.abort(), 20);
      },
    }),
    (e) => e.message === 'cancelled',
  );
  await gone(roots[0].root);
  const g = await fixture(t),
    drift = [];
  await assert.rejects(
    runCodexNetworkCheckEngine(g.input, {
      ...g.options,
      onScratch: (s) => drift.push(s),
      fault: async (stage) => {
        if (stage === 'after-positive') await writeFile(g.native, 'changed');
      },
    }),
    (e) => e.message === 'native-changed',
  );
  await gone(drift[0].root);
});
test('unknown endpoint/profile fields and unresolved graphs are refused before scratch or execution', async (t) => {
  const f = await fixture(t);
  for (const profiles of [
    { selected: { network: { enabled: false, proxy_url: 'http://not-run' } } },
    { selected: { extends: 'missing', network: { enabled: false } } },
    { selected: { extends: 'selected', network: { enabled: false } } },
  ]) {
    let made = false;
    await assert.rejects(
      runCodexNetworkCheckEngine(
        { ...f.input, profiles },
        { ...f.options, onScratch: () => (made = true) },
      ),
    );
    assert.equal(made, false);
  }
});
test('missing ownership marker cannot be reported as confirmed cleanup; callback failure still removes unmarked owned root', async (t) => {
  const f = await fixture(t),
    roots = [];
  t.after(async () => {
    for (const s of roots) await rm(s.root, { recursive: true, force: true });
  });
  await assert.rejects(
    runCodexNetworkCheckEngine(f.input, {
      ...f.options,
      onScratch: (s) => roots.push(s),
      fault: async (stage, detail) => {
        if (stage === 'before-cleanup')
          await rm(join(detail.scratch.root, '.stroq-live-throwaway'));
      },
    }),
    (e) => e.message === 'cleanup-failed',
  );
  const g = await fixture(t),
    early = [];
  await assert.rejects(
    runCodexNetworkCheckEngine(g.input, {
      ...g.options,
      onScratch: (s) => {
        early.push(s);
        throw Error('registration failed');
      },
    }),
  );
  await gone(early[0].root);
});
test('copy binding is frozen before callbacks; later caller mutation cannot relabel executed policy', async (t) => {
  const f = await fixture(t),
    expected = getProfileCopySha(f.input);
  const r = await runCodexNetworkCheckEngine(f.input, {
    ...f.options,
    fault: (stage) => {
      if (stage === 'after-positive') f.input.profiles.selected.network.enabled = true;
    },
  });
  assert.equal(r.profileCopySha256, expected);
  assert.equal(r.outcome, 'passed');
});
