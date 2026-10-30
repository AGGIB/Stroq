import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'tsup';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await mkdtemp(join(tmpdir(), 'stroq-hook-check-test-'));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: { engine: resolve(repository, 'console/scripts/hook-check-engine.ts') },
  outDir: output,
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  splitting: false,
  config: false,
  dts: false,
  silent: true,
  noExternal: ['@stroq/core', 'yaml', 'zod'],
  banner: {
    js: "import { createRequire as createHookCheckRequire } from 'node:module'; const require = createHookCheckRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.alias = { '@stroq/core': resolve(repository, 'packages/core/src/index.ts') };
  },
});
const engine = await import(pathToFileURL(join(output, 'engine.mjs')).href);
const { executeHookCheck } = await import('./hook-check-process.mjs');
const cliPath = resolve(repository, 'packages/cli/dist/index.js');
const adapterPath = join(output, 'engine.mjs');
const builtin = (agent = 'claude-code') => ({
  agent,
  policyText: null,
  policySemanticSha256: engine.hookCheckPolicySha256(null),
});
const gone = async (path) => assert.rejects(lstat(path), { code: 'ENOENT' });
const fakeCli = async (name, source) => {
  const file = join(output, `${name}.cjs`);
  await writeFile(file, source);
  return file;
};
function resultShape(result) {
  assert.deepEqual(Object.keys(result).sort(), ['probes', 'standard', 'status']);
  assert.deepEqual(
    result.probes.map((probe) => probe.id),
    ['ordinary', 'encoded-fetch'],
  );
  for (const probe of result.probes)
    assert.deepEqual(Object.keys(probe).sort(), [
      'auditConfirmed',
      'durationMs',
      'exitCode',
      'expectedEffect',
      'expectedWire',
      'id',
      'matched',
      'observedEffect',
      'wireEffect',
    ]);
}

test('fixed event suite and strict protocol decoding cover all three agents explicitly', () => {
  assert.throws(() => engine.hookCheckEvent('unknown', 'ordinary', '/scratch/project'));
  for (const agent of ['claude-code', 'cursor', 'codex']) {
    assert.equal(engine.hookCheckExpectedWire(agent, 'ask'), agent === 'codex' ? 'deny' : 'ask');
    assert.equal(
      engine.decodeHookCheckWire(agent, { stdout: '', stderr: '', code: null }),
      'unreadable',
    );
    assert.equal(
      engine.decodeHookCheckWire(agent, { stdout: 'not-json', stderr: '', code: 0 }),
      'unreadable',
    );
  }
  // Windsurf is no longer checked: no event, no expected wire, and its old wire never decodes.
  assert.throws(() => engine.hookCheckEvent('windsurf', 'ordinary', '/scratch/project'), {
    message: 'invalid-input',
  });
  assert.throws(() => engine.hookCheckExpectedWire('windsurf', 'ask'), {
    message: 'invalid-input',
  });
  for (const run of [
    { stdout: '', stderr: 'blocked', code: 2 },
    { stdout: '', stderr: '', code: 0 },
  ])
    assert.equal(engine.decodeHookCheckWire('windsurf', run), 'unreadable');
  assert.equal(
    engine.decodeHookCheckWire('claude-code', {
      stdout:
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"blocked"}}',
      stderr: '',
      code: 2,
    }),
    'unreadable',
  );
  assert.equal(
    engine.decodeHookCheckWire('cursor', {
      stdout: '{"permission":"deny","unexpected":"PRIVATE"}',
      stderr: '',
      code: 0,
    }),
    'unreadable',
  );
});

test(
  'actual bundled hook CLI agrees with independent engine and bound journal for all agents',
  { timeout: 45_000 },
  async () => {
    for (const agent of ['claude-code', 'cursor', 'codex']) {
      const roots = [];
      const result = await executeHookCheck(builtin(agent), {
        adapterPath,
        cliPath,
        timeoutMs: 20_000,
        fault(stage, details) {
          if (stage === 'scratch-created') roots.push(details.actual.root, details.reference.root);
        },
      });
      resultShape(result);
      assert.equal(result.status, 'passed', agent);
      assert.deepEqual(result.standard, { ordinaryAllowed: true, encodedDenied: true });
      assert.ok(result.probes.every((probe) => probe.matched && probe.auditConfirmed));
      assert.deepEqual(
        result.probes.map((probe) => probe.observedEffect),
        ['allow', 'deny'],
      );
      assert.equal(roots.length, 4);
      for (const root of roots) await gone(root);
      assert.ok(!JSON.stringify(result).includes('stroq.invalid'));
    }
  },
);

test(
  'selected ask policy is honored without fallback and exposes wire loss only as derived effects',
  { timeout: 20_000 },
  async () => {
    const policyText = 'version: 1\ndefault: ask\nrules: []\n';
    for (const agent of ['claude-code', 'codex']) {
      const result = await executeHookCheck(
        { agent, policyText, policySemanticSha256: engine.hookCheckPolicySha256(policyText) },
        { adapterPath, cliPath },
      );
      assert.equal(result.status, 'attention');
      assert.ok(result.probes.every((probe) => probe.matched && probe.expectedEffect === 'ask'));
      assert.ok(
        result.probes.every(
          (probe) => probe.wireEffect === (agent === 'claude-code' ? 'ask' : 'deny'),
        ),
      );
    }
  },
);

test('invalid or semantically stale policy is refused before scratch or hook work', async () => {
  for (const input of [
    { ...builtin(), policyText: 'version: nope' },
    { ...builtin(), policySemanticSha256: '0'.repeat(64) },
    { ...builtin(), policyText: 'version: 1\ndefault: allow\nrules: []\nversion: 1' },
  ]) {
    let touched = false;
    await assert.rejects(
      executeHookCheck(input, {
        adapterPath,
        cliPath,
        fault() {
          touched = true;
        },
      }),
      { message: 'invalid-policy' },
    );
    assert.equal(touched, false);
  }
});

test('a windsurf check is refused as invalid input before scratch or hook work', async () => {
  let touched = false;
  await assert.rejects(
    executeHookCheck(builtin('windsurf'), {
      adapterPath,
      cliPath,
      fault() {
        touched = true;
      },
    }),
    { message: 'invalid-input' },
  );
  assert.equal(touched, false);
});

test('a plausible wire deny without the actual engine journal never passes', async () => {
  const fake = await fakeCli(
    'fake-deny',
    `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'PRIVATE'}})));`,
  );
  const result = await executeHookCheck(builtin(), { adapterPath, cliPath: fake });
  assert.equal(result.status, 'failed');
  assert.ok(
    result.probes.every(
      (probe) => !probe.matched && !probe.auditConfirmed && probe.observedEffect === null,
    ),
  );
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('audit corruption and event substitution cannot establish a policy decision', async () => {
  for (const substitution of ['hash', 'session']) {
    const result = await executeHookCheck(builtin(), {
      adapterPath,
      cliPath,
      async fault(stage, details) {
        if (stage !== 'after-hook') return;
        const file = join(details.actual.stroqHome, 'audit.jsonl');
        const entry = JSON.parse((await readFile(file, 'utf8')).trim());
        if (substitution === 'hash') entry.hash = '0'.repeat(64);
        else {
          entry.sessionId = 'different-event';
          const { hash: ignored, ...unhashed } = entry;
          const stable = (value) =>
            value && typeof value === 'object'
              ? Array.isArray(value)
                ? `[${value.map(stable).join(',')}]`
                : `{${Object.keys(value)
                    .sort()
                    .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
                    .join(',')}}`
              : JSON.stringify(value);
          entry.hash = createHash('sha256').update(stable(unhashed)).digest('hex');
        }
        await writeFile(file, JSON.stringify(entry) + '\n');
      },
    });
    assert.equal(result.status, 'failed', substitution);
    assert.ok(
      result.probes.every((probe) => !probe.auditConfirmed && probe.observedEffect === null),
    );
  }
});

test('strict scratch environment excludes ambient secrets, config and Node injection', async () => {
  const fake = await fakeCli(
    'capture-env',
    `const fs=require('node:fs');fs.writeFileSync(process.env.HOME+'/captured.json',JSON.stringify({env:process.env,args:process.execArgv,cwd:process.cwd()}));process.stdin.resume();`,
  );
  const previous = process.env.STROQ_TEST_PRIVATE_KEY;
  process.env.STROQ_TEST_PRIVATE_KEY = 'PRIVATE_SENTINEL';
  try {
    let checked = 0;
    await executeHookCheck(builtin(), {
      adapterPath,
      cliPath: fake,
      async fault(stage, details) {
        if (stage !== 'after-hook') return;
        const captured = JSON.parse(
          await readFile(join(details.actual.home, 'captured.json'), 'utf8'),
        );
        assert.equal(captured.env.STROQ_TEST_PRIVATE_KEY, undefined);
        for (const name of [
          'NODE_OPTIONS',
          'NODE_PATH',
          'CLAUDE_CONFIG_DIR',
          'CODEX_HOME',
          'OPENAI_API_KEY',
        ])
          assert.equal(captured.env[name], undefined);
        assert.equal(captured.env.HOME, details.actual.home);
        assert.equal(captured.env.STROQ_HOME, details.actual.stroqHome);
        assert.equal(captured.cwd, await realpath(details.actual.project));
        assert.deepEqual(captured.args, ['--max-old-space-size=256']);
        checked++;
      },
    });
    assert.equal(checked, 2);
  } finally {
    if (previous === undefined) delete process.env.STROQ_TEST_PRIVATE_KEY;
    else process.env.STROQ_TEST_PRIVATE_KEY = previous;
  }
});

test(
  'abort and deadline kill hook process groups and remove every scratch root before rejecting',
  { timeout: 20_000 },
  async () => {
    const fake = await fakeCli('never-answer', `process.stdin.resume();setInterval(()=>{},1000);`);
    for (const mode of ['abort', 'deadline']) {
      const roots = [],
        controller = new AbortController();
      let cancellation;
      const promise = executeHookCheck(builtin(), {
        adapterPath,
        cliPath: fake,
        signal: controller.signal,
        timeoutMs: mode === 'deadline' ? 1500 : 10_000,
        fault(stage, details) {
          if (stage === 'scratch-created') {
            roots.push(details.actual.root, details.reference.root);
            if (mode === 'abort') cancellation = setTimeout(() => controller.abort(), 100);
          }
        },
      });
      await assert.rejects(promise, {
        message: mode === 'abort' ? 'cancelled' : 'deadline-exceeded',
      });
      clearTimeout(cancellation);
      assert.ok(roots.length >= 2);
      for (const root of roots) await gone(root);
    }
  },
);

test('output overflow terminates work and cleans scratch rather than truncating a false response', async () => {
  const fake = await fakeCli(
    'output-overflow',
    `process.stdin.resume();process.stdout.write('PRIVATE'.repeat(100000));setInterval(()=>{},1000);`,
  );
  const roots = [];
  await assert.rejects(
    executeHookCheck(builtin(), {
      adapterPath,
      cliPath: fake,
      fault(stage, details) {
        if (stage === 'scratch-created') roots.push(details.actual.root, details.reference.root);
      },
    }),
    { message: 'output-limit' },
  );
  for (const root of roots) await gone(root);
});

test(
  'a normally exited hook cannot leave a descendant running in its process group',
  { timeout: 10_000 },
  async () => {
    const fake = await fakeCli(
      'orphan-child',
      `const{spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();fs.writeFileSync(process.env.HOME+'/child.pid',String(child.pid));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`,
    );
    const pids = [];
    try {
      const result = await executeHookCheck(builtin(), {
        adapterPath,
        cliPath: fake,
        async fault(stage, details) {
          if (stage === 'after-hook')
            pids.push(Number(await readFile(join(details.actual.home, 'child.pid'), 'utf8')));
        },
      });
      assert.equal(result.status, 'failed');
      assert.equal(pids.length, 2);
      for (const pid of pids) {
        let alive = true;
        for (let attempt = 0; attempt < 40 && alive; attempt++) {
          try {
            process.kill(pid, 0);
            await new Promise((resolve) => setTimeout(resolve, 25));
          } catch (error) {
            assert.equal(error.code, 'ESRCH');
            alive = false;
          }
        }
        assert.equal(alive, false, 'grandchild must be gone before a result is accepted');
      }
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Already gone. */
        }
      }
    }
  },
);

test('an intact real audit cannot turn an invalid exit code into a matched wire result', async () => {
  const fake = await fakeCli(
    'wrong-exit',
    `const{spawnSync}=require('node:child_process');const fs=require('node:fs');const result=spawnSync(process.execPath,[${JSON.stringify(cliPath)},...process.argv.slice(2)],{input:fs.readFileSync(0),env:process.env,maxBuffer:131072});process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exit(7);`,
  );
  const result = await executeHookCheck(builtin(), { adapterPath, cliPath: fake });
  assert.equal(result.status, 'failed');
  assert.ok(
    result.probes.every(
      (probe) =>
        probe.auditConfirmed &&
        probe.observedEffect === probe.expectedEffect &&
        !probe.matched &&
        probe.wireEffect === 'unreadable' &&
        probe.exitCode === 7,
    ),
  );
});

test('oversized audit data is refused without deriving a decision from its prefix', async () => {
  const result = await executeHookCheck(builtin(), {
    adapterPath,
    cliPath,
    async fault(stage, details) {
      if (stage === 'after-hook')
        await writeFile(
          join(details.actual.stroqHome, 'audit.jsonl'),
          Buffer.alloc(200 * 1024, 0x61),
        );
    },
  });
  assert.equal(result.status, 'failed');
  assert.ok(result.probes.every((probe) => !probe.auditConfirmed && probe.observedEffect === null));
});

test('failed scratch ownership verification throws cleanup-failed and preserves the unverified root', async () => {
  let preserved;
  try {
    await assert.rejects(
      executeHookCheck(builtin(), {
        adapterPath,
        cliPath,
        async fault(stage, details) {
          if (stage !== 'before-cleanup') return;
          preserved = details.roots[0].root;
          await rm(join(preserved, '.stroq-live-throwaway'));
        },
      }),
      { message: 'cleanup-failed' },
    );
    assert.ok((await lstat(preserved)).isDirectory());
  } finally {
    if (preserved) {
      await writeFile(
        join(preserved, '.stroq-live-throwaway'),
        'made by stroq prove: everything in this directory may be removed\n',
        { mode: 0o600 },
      );
      await rm(preserved, { recursive: true, force: true });
    }
  }
});

test('an abruptly killed worker still has its hook group killed and registered scratch removed', async () => {
  const fake = await fakeCli(
    'kill-worker',
    `process.stdin.resume();process.stdin.on('end',()=>{process.kill(process.ppid,'SIGKILL');setInterval(()=>{},1000);});`,
  );
  const roots = [];
  await assert.rejects(
    executeHookCheck(builtin(), {
      adapterPath,
      cliPath: fake,
      fault(stage, details) {
        if (stage === 'scratch-created') roots.push(details.actual.root, details.reference.root);
      },
    }),
    { message: 'hook-check-failed' },
  );
  assert.equal(roots.length, 2);
  for (const root of roots) await gone(root);
});
