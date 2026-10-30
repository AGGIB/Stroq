import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
  rename,
  link,
  symlink,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { build } from 'tsup';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-codex-controls-build-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    controls: join(repository, 'console/scripts/codex-skill-control-operations.ts'),
    store: join(repository, 'console/scripts/codex-skill-control-store.ts'),
    selection: join(repository, 'console/scripts/codex-skill-control-selection.ts'),
    bindings: join(repository, 'console/scripts/codex-skill-control-binding.ts'),
    transform: join(repository, 'console/scripts/codex-skill-control-toml.ts'),
    schema: join(repository, 'console/lib/codex-skill-controls.ts'),
    capture: join(repository, 'console/scripts/codex-skill-source-capture.ts'),
    privateSchema: join(repository, 'console/lib/codex-skill-controls-private.ts'),
  },
  outDir: output,
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  splitting: false,
  config: false,
  dts: false,
  silent: true,
  noExternal: ['@stroq/core', 'yaml', 'zod', 'smol-toml'],
  banner: {
    js: "import {createRequire as fixtureRequire} from 'node:module';const require=fixtureRequire(import.meta.url);",
  },
  esbuildOptions(o) {
    o.alias = { '@stroq/core': join(repository, 'packages/core/src/index.ts') };
  },
});
const api = await import(pathToFileURL(join(output, 'controls.mjs')).href);
const schema = await import(pathToFileURL(join(output, 'schema.mjs')).href);
test('control state is read only, context opaque, legacy selectors cannot authorize writes', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-codex-controls-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'project'),
    userHome = join(base, 'user');
  await mkdir(project);
  await mkdir(userHome);
  const options = {
    project,
    userHome,
    deadline: Date.now() + 15000,
    runtimeSha256: 'a'.repeat(64),
  };
  const state = await api.runCodexSkillControlOperation('codex-control-state', options, {});
  assert.equal(schema.validateCodexSkillControlState(state), true);
  assert.equal(state.history, 'missing');
  assert.match(state.controlContextId, /^codex-context-[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(state).includes(base), false);
  assert.equal(
    schema.validateCodexSkillControlSelection({
      operation: 'disable',
      controlContextId: state.controlContextId,
      sourceId: 'source-' + 'b'.repeat(24),
      candidateId: 'candidate-' + 'c'.repeat(24),
      expectedEntrypointSha256: 'd'.repeat(64),
      expectedConfigSha256: null,
      expectedRuntimeSha256: 'a'.repeat(64),
      path: '/tmp/evil',
    }),
    false,
  );
});

const capture = await import(pathToFileURL(join(output, 'capture.mjs')).href);
const privateSchema = await import(pathToFileURL(join(output, 'privateSchema.mjs')).href);
test('a clock tick between preview timestamps cannot invalidate a newly created private plan', async (t) => {
  const f = await fixture(t);
  await f.skill();
  const request = (await f.select()).request;
  const OriginalDate = Date;
  let clock = OriginalDate.now();
  globalThis.Date = class extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [clock++]));
    }
    static now() {
      return clock++;
    }
  };
  try {
    const p = await f.preview(request);
    assert.equal(
      OriginalDate.parse(p.preview.expiresAt) - OriginalDate.parse(p.preview.createdAt),
      120000,
    );
    assert.equal(privateSchema.validateCodexSkillControlPrivatePlan(p.privatePlan), true);
  } finally {
    globalThis.Date = OriginalDate;
  }
});
const { runtimeDigest } = await import(
  pathToFileURL(join(repository, 'console/scripts/runtime-digest.mjs')).href
);
async function fixture(t, { config, mode = 0o640 } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-codex-controls-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'project'),
    userHome = join(base, 'user'),
    runtime = join(base, 'runtime');
  await mkdir(project);
  await mkdir(userHome);
  await mkdir(runtime);
  await writeFile(join(runtime, 'cli.js'), '// fixture');
  await writeFile(join(runtime, 'package.json'), '{}');
  const runtimePaths = { cli: join(runtime, 'cli.js'), package: join(runtime, 'package.json') };
  const options = {
    project,
    userHome,
    deadline: Date.now() + 60000,
    runtimePaths,
    runtimeSha256: await runtimeDigest(runtimePaths),
  };
  const target = join(userHome, '.codex', 'config.toml');
  if (config !== undefined) {
    await mkdir(dirname(target), { mode: 0o700 });
    await writeFile(target, config, { mode });
  }
  async function skill(name = 'notes', folder = 'notes') {
    const path = join(project, '.agents', 'skills', folder, 'SKILL.md');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `---\nname: ${name}\ndescription: Summarize notes.\n---\nSummarize notes.\n`.replaceAll(
        '\\n',
        '\n',
      ),
    );
    return path;
  }
  async function select(index = 0) {
    const report = await capture.captureCodexSkillSources(options),
      item = report.items[index];
    assert.ok(item, 'selected fixture skill');
    const request = {
      operation: 'disable',
      controlContextId: report.context.controlContextId,
      sourceId: item.sourceId,
      candidateId: item.id,
      expectedEntrypointSha256: item.entrypointSha256,
      expectedConfigSha256: report.settings.sha256,
      expectedRuntimeSha256: report.runtimeSha256,
    };
    return { report, request };
  }
  const preview = async (request) =>
    api.runCodexSkillControlOperation('codex-control-preview', options, { request });
  const apply = async (plan, hooks) =>
    api.runCodexSkillControlOperation(
      'codex-control-apply',
      options,
      {
        privatePlan: structuredClone(plan),
        acknowledgeSharedUserConfig: true,
        acknowledgeRetention: true,
        ...(plan.preview.operation === 'restore' ? { acknowledgeWeakening: true } : {}),
        writerLockHeld: true,
      },
      hooks,
    );
  const state = () => api.runCodexSkillControlOperation('codex-control-state', options, {});
  const recheck = (record) =>
    api.runCodexSkillControlOperation('codex-control-recheck', options, {
      request: {
        controlContextId: record.controlContextId,
        recordId: record.id,
        recordRevision: record.revision,
        operationId: record.operationId,
      },
      writerLockHeld: true,
    });
  const restore = (record) =>
    preview({
      operation: 'restore',
      controlContextId: record.controlContextId,
      recordId: record.id,
      recordRevision: record.revision,
    });
  return {
    base,
    project,
    userHome,
    options,
    target,
    skill,
    select,
    preview,
    apply,
    state,
    recheck,
    restore,
  };
}
test('missing default directory disable and restore preserve exact path and opaque context', async (t) => {
  const f = await fixture(t);
  const path = await f.skill();
  const { report, request } = await f.select();
  const plan = await f.preview(request);
  assert.equal(schema.validateCodexSkillControlPreview(plan.preview), true);
  assert.equal(privateSchema.validateCodexSkillControlPrivatePlan(plan.privatePlan), true);
  assert.equal(
    privateSchema.validateCodexSkillControlPrivatePlan(structuredClone(plan.privatePlan)),
    true,
  );
  const result = await f.apply(plan.privatePlan);
  assert.equal(schema.validateCodexSkillControlReceipt(result), true);
  assert.equal(result.record.standing, 'disabled');
  assert.equal(result.record.canRestore, true);
  assert.equal(result.operationId, plan.preview.operationId);
  const native = await readFile(f.target, 'utf8');
  assert.ok(native.includes(JSON.stringify(path)));
  assert.ok(native.includes('enabled = false'));
  assert.equal(
    (await capture.captureCodexSkillSources(f.options)).context.controlContextId,
    report.context.controlContextId,
  );
  assert.equal((await readFile(path, 'utf8')).includes('Summarize notes.'), true);
  await rm(dirname(path), { recursive: true });
  const restore = await f.restore(result.record);
  assert.equal(restore.preview.afterSha256, null);
  assert.equal(restore.preview.binding, null);
  const restored = await f.apply(restore.privatePlan);
  assert.equal(schema.validateCodexSkillControlReceipt(restored), true);
  assert.equal(restored.record.operationStatus, 'restored');
  await assert.rejects(readFile(f.target), { code: 'ENOENT' });
  assert.equal(JSON.stringify(restored).includes(f.base), false);
});
test('restore preserves unrelated later TOML bytes and never enables newer rows', async (t) => {
  const original = '# personal\r\nmodel = "example"\r\n';
  const f = await fixture(t, { config: original });
  await f.skill();
  const p = await f.preview((await f.select()).request);
  const r = await f.apply(p.privatePlan);
  const later = '\r\n[extra]\r\nvalue = "kept"\r\n';
  await writeFile(f.target, (await readFile(f.target, 'utf8')) + later, { mode: 0o640 });
  const restore = await f.restore(r.record),
    receipt = await f.apply(restore.privatePlan);
  assert.equal(receipt.record.operationStatus, 'restored');
  assert.equal(await readFile(f.target, 'utf8'), original + later);
});
test('same-name copies count uses private native normalization and already-disabled is refused', async (t) => {
  const f = await fixture(t);
  await f.skill('notes', 'one');
  await f.skill('notes', 'two');
  const p = await f.preview((await f.select()).request);
  assert.equal(p.preview.sameNameCopies, 1);
  await f.apply(p.privatePlan);
  const { request } = await f.select(0);
  await assert.rejects(f.preview(request), /codex-control-already-disabled/);
});
test('candidate and config changes invalidate private previews without a target write', async (t) => {
  const f = await fixture(t, { config: '# before\n' });
  const path = await f.skill();
  const p = await f.preview((await f.select()).request);
  await writeFile(path, '---\nname: notes\ndescription: changed\n---\nchanged\n');
  await assert.rejects(f.apply(p.privatePlan), /codex-control-stale|preview-stale/);
  assert.equal(await readFile(f.target, 'utf8'), '# before\n');
});
test('unknown write only rechecks exact publication inode and operation', async (t) => {
  const f = await fixture(t, { config: '# before\n' });
  await f.skill();
  const p = await f.preview((await f.select()).request);
  await assert.rejects(
    f.apply(p.privatePlan, {
      fault: async (stage) => {
        if (stage === 'after-target-rename') throw Error('lost');
      },
    }),
    /codex-control-write-unconfirmed/,
  );
  const state = await f.state();
  assert.equal(state.records[0].operationStatus, 'unknown');
  const checked = await f.recheck(state.records[0]);
  assert.equal(checked.writeConfirmed, true);
  assert.equal(checked.record.operationStatus, 'disabled');
  const restore = await f.restore(checked.record);
  await assert.rejects(
    f.apply(restore.privatePlan, {
      fault: async (stage) => {
        if (stage === 'after-target-rename') throw Error('lost');
      },
    }),
    /codex-control-write-unconfirmed/,
  );
  const pending = (await f.state()).records[0];
  assert.equal(pending.operationStatus, 'unknown');
  assert.equal(pending.operationId, restore.preview.operationId);
  await assert.rejects(
    f.recheck({ ...pending, operationId: p.preview.operationId }),
    /codex-control-stale/,
  );
  assert.equal((await f.recheck(pending)).record.operationStatus, 'restored');
});
test('unchanged old bytes and a foreign equal candidate cannot clear unknown', async (t) => {
  const f = await fixture(t, { config: '# before\n' });
  await f.skill();
  const p = await f.preview((await f.select()).request);
  await assert.rejects(
    f.apply(p.privatePlan, {
      fault: async (stage) => {
        if (stage === 'after-intent') throw Error('lost');
      },
    }),
    /codex-control-write-unconfirmed/,
  );
  let pending = (await f.state()).records[0];
  assert.equal((await f.recheck(pending)).writeConfirmed, false);
  assert.equal((await f.state()).records[0].revision, pending.revision);
  await writeFile(f.target, Buffer.from(p.privatePlan.candidate));
  pending = (await f.state()).records[0];
  assert.equal((await f.recheck(pending)).writeConfirmed, false);
  await assert.rejects(f.preview((await f.select()).request), /codex-control-recovery-required/);
});
test('absence after interrupted restore remains unknown and does not become completion', async (t) => {
  const f = await fixture(t);
  await f.skill();
  const p = await f.preview((await f.select()).request);
  const r = await f.apply(p.privatePlan);
  const restore = await f.restore(r.record);
  await assert.rejects(
    f.apply(restore.privatePlan, {
      fault: async (stage) => {
        if (stage === 'after-target-rename') throw Error('lost');
      },
    }),
    /codex-control-write-unconfirmed/,
  );
  const pending = (await f.state()).records[0];
  assert.equal((await f.recheck(pending)).writeConfirmed, false);
  assert.equal((await f.state()).records[0].operationStatus, 'unknown');
});
test('config byte CAS and runtime changes are refused before retention or target mutation', async (t) => {
  const f = await fixture(t, { config: '# original\n' });
  await f.skill();
  const p = await f.preview((await f.select()).request);
  await writeFile(f.target, '# foreign\n');
  await assert.rejects(f.apply(p.privatePlan), /codex-control-stale/);
  assert.equal(await readFile(f.target, 'utf8'), '# foreign\n');
  assert.equal((await f.state()).records.length, 0);
  const fresh = await f.preview((await f.select()).request);
  await writeFile(f.options.runtimePaths.cli, '// replaced');
  await assert.rejects(f.apply(fresh.privatePlan), /codex-control-runtime-changed/);
  assert.equal((await f.state()).records.length, 0);
});
test('consents and exact closed private plan are required, including restore weakening', async (t) => {
  const f = await fixture(t);
  await f.skill();
  const p = await f.preview((await f.select()).request);
  await assert.rejects(
    api.runCodexSkillControlOperation('codex-control-apply', f.options, {
      privatePlan: p.privatePlan,
      writerLockHeld: true,
    }),
    /codex-control-consent-required/,
  );
  const forged = structuredClone(p.privatePlan);
  forged.owned.documentPath = '/tmp/other/SKILL.md';
  assert.equal(privateSchema.validateCodexSkillControlPrivatePlan(forged), false);
  await assert.rejects(f.apply(forged), /codex-control-stale/);
  assert.equal((await f.state()).records.length, 0);
  const r = await f.apply(p.privatePlan),
    restore = await f.restore(r.record);
  await assert.rejects(
    api.runCodexSkillControlOperation('codex-control-apply', f.options, {
      privatePlan: restore.privatePlan,
      acknowledgeSharedUserConfig: true,
      acknowledgeRetention: true,
      writerLockHeld: true,
    }),
    /codex-control-consent-required/,
  );
});
test('owned and earlier declarations edited by others refuse restore and do not rewrite bytes', async (t) => {
  const f = await fixture(t, { config: '[[skills.config]]\nname = "other"\nenabled = true\n' });
  await f.skill();
  const p = await f.preview((await f.select()).request),
    r = await f.apply(p.privatePlan);
  const edited = (await readFile(f.target, 'utf8')).replace('name = "other"', 'name = "changed"');
  await writeFile(f.target, edited);
  await assert.rejects(f.restore(r.record), /codex-control-conflict/);
  assert.equal(await readFile(f.target, 'utf8'), edited);
  assert.equal((await f.state()).records[0].canRestore, false);
});
test('history current standing is distinct from proof of a completed operation', async (t) => {
  const f = await fixture(t, { config: '# original\n' });
  await f.skill();
  const p = await f.preview((await f.select()).request),
    r = await f.apply(p.privatePlan);
  await writeFile(f.target, '# new user config\n');
  const checked = await f.recheck(r.record);
  assert.equal(checked.writeConfirmed, true);
  assert.equal(checked.record.operationStatus, 'disabled');
  assert.equal(checked.record.standing, 'enabled-or-unspecified');
  assert.equal(checked.record.canRestore, false);
});
test('orphan marker staging is bounded and never silently repaired or overwritten', async (t) => {
  const f = await fixture(t);
  await f.skill();
  const vault = join(f.userHome, '.stroq', 'codex-skill-controls');
  await mkdir(vault, { recursive: true, mode: 0o700 });
  for (let n = 0; n < 2; n++)
    await writeFile(join(vault, `.stroq-0000000${n}-0000-0000-0000-000000000000.tmp`), '*', {
      mode: 0o600,
    });
  const state = await f.state();
  assert.equal(state.available, false);
  assert.equal(state.history, 'unavailable');
  assert.equal(state.error, 'codex-control-store-unavailable');
});

test('restore never adopts the same bytes in a replacement data-directory parent', async (t) => {
  const f = await fixture(t, { config: '# before\n' });
  await f.skill();
  const p = await f.preview((await f.select()).request),
    r = await f.apply(p.privatePlan);
  const old = dirname(f.target) + '-old';
  await rename(dirname(f.target), old);
  await mkdir(dirname(f.target), { mode: 0o700 });
  await rename(join(old, 'config.toml'), f.target);
  await assert.rejects(f.restore(r.record), /codex-control-stale|codex-control-conflict/);
  assert.equal((await f.state()).records[0].canRestore, false);
});
test('changed standing capture is unavailable even when restore feasibility conflicts', async (t) => {
  const f = await fixture(t, { config: '# original\n' });
  await f.skill();
  const p = await f.preview((await f.select()).request);
  await f.apply(p.privatePlan);
  const result = await api.runCodexSkillControlOperation(
    'codex-control-state',
    f.options,
    {},
    {
      fault: async (stage) => {
        if (stage === 'after-standing-capture') await writeFile(f.target, '# foreign config\n');
      },
    },
  );
  assert.equal(result.records[0].standing, 'unavailable');
  assert.equal(result.records[0].canRestore, false);
});
test('absence restore never deletes a foreign replacement in the final rename window', async (t) => {
  const f = await fixture(t);
  await f.skill();
  const p = await f.preview((await f.select()).request),
    r = await f.apply(p.privatePlan),
    restore = await f.restore(r.record);
  await assert.rejects(
    f.apply(restore.privatePlan, {
      fault: async (stage) => {
        if (stage === 'before-removal-rename')
          await writeFile(f.target, '# unrelated newer config\n');
      },
    }),
    /codex-control-write-unconfirmed/,
  );
  const tombstone = join(
    dirname(f.target),
    `.stroq-skill-restore-${restore.preview.operationId}.tmp`,
    'config.toml',
  );
  assert.equal(await readFile(tombstone, 'utf8'), '# unrelated newer config\n');
  const state = await f.state();
  assert.equal(state.records[0].operationStatus, 'unknown');
  assert.equal((await f.recheck(state.records[0])).writeConfirmed, false);
  assert.equal(await readFile(tombstone, 'utf8'), '# unrelated newer config\n');
});
test('orphan metadata staging prevents another atomic metadata publication without cleanup', async (t) => {
  const f = await fixture(t, { config: '# original\n' });
  await f.skill();
  const p = await f.preview((await f.select()).request);
  await assert.rejects(
    f.apply(p.privatePlan, {
      fault: async (stage) => {
        if (stage === 'after-target-rename') throw Error('lost');
      },
    }),
    /codex-control-write-unconfirmed/,
  );
  const pending = (await f.state()).records[0],
    path = join(
      f.userHome,
      '.stroq',
      'codex-skill-controls',
      pending.id,
      '.stroq-00000000-0000-0000-0000-000000000000.tmp',
    );
  await writeFile(path, '{}', { mode: 0o600 });
  assert.equal((await f.state()).available, false);
  await assert.rejects(f.recheck(pending), /codex-control-recovery-required/);
  assert.equal(await readFile(path, 'utf8'), '{}');
});

test('vault enforces both 32-record and 17MiB physical reservations including future metadata/stage', async (t) => {
  const store = await import(pathToFileURL(join(output, 'store.mjs')).href),
    bindings = await import(pathToFileURL(join(output, 'bindings.mjs')).href),
    transform = await import(pathToFileURL(join(output, 'transform.mjs')).href);
  for (const large of [false, true]) {
    const f = await fixture(t, {
      config: large ? '#' + 'x'.repeat(256 * 1024 - 1000) + '\n' : '# initial\n',
    });
    await f.skill();
    const p = await f.preview((await f.select()).request);
    await f.apply(p.privatePlan);
    const context = await bindings.controlContext(f.options),
      initial = (await store.readControlVault(context)).records[0];
    const before = large ? Buffer.from('#' + 'x'.repeat(256 * 1024 - 1000) + '\n') : initial.before;
    let accepted = 1;
    for (let n = 1; n < 34; n++) {
      const id = randomUUID(),
        planned = transform.planCodexSkillDisable({
          bytes: before,
          documentPath: initial.manifest.documentPath,
          operationId: id,
        });
      const candidate = Buffer.from(planned.bytes),
        hash = (bytes) => createHash('sha256').update(bytes).digest('hex'),
        file = { ...initial.manifest.publication, size: candidate.length };
      const { ctimeMs, ...staged } = file;
      const m = {
        ...initial.manifest,
        id,
        operationId: randomUUID(),
        originalSha256: hash(before),
        candidateSha256: hash(candidate),
        beforeBytes: before.length,
        candidateBytes: candidate.length,
        staged,
        publication: file,
      };
      try {
        await store.createControlRecord(context, m, before, candidate, async () => {});
        accepted++;
      } catch (error) {
        assert.match(error.message, /codex-control-store-full/);
        break;
      }
    }
    const vault = await store.readControlVault(context);
    assert.equal(vault.count, accepted);
    assert.ok(vault.bytes <= 17 * 1024 * 1024);
    assert.ok(vault.bytes >= 256 * 1024 + accepted * 2 * 16384);
    if (large) assert.ok(accepted < 32, 'large raw copies hit bytes before count');
    else assert.equal(accepted, 32);
    assert.equal(await readFile(f.target, 'utf8'), Buffer.from(p.privatePlan.candidate).toString());
  }
});
test('links and unsafe modes never become a native config writer', async (t) => {
  const f = await fixture(t, { config: '# original\n' });
  const path = await f.skill(),
    p = await f.preview((await f.select()).request);
  await link(path, path + '.alias');
  await assert.rejects(f.apply(p.privatePlan), /codex-control-unsupported|codex-control-stale/);
  assert.equal((await f.state()).records.length, 0);
  await rm(path + '.alias');
  const next = await f.preview((await f.select()).request);
  await rename(f.target, f.target + '.original');
  await symlink(f.target + '.original', f.target);
  await assert.rejects(f.apply(next.privatePlan), /codex-control-unsupported|codex-control-stale/);
  assert.equal(await readFile(f.target + '.original', 'utf8'), '# original\n');
  await rm(f.target);
  await rename(f.target + '.original', f.target);
  await chmod(f.target, 0o666);
  await assert.rejects(f.preview((await f.select()).request), /codex-control-unsupported/);
});

test('selected entrypoint byte, mode and inode drift have a closed stale code before retention', async (t) => {
  const selected = await import(pathToFileURL(join(output, 'selection.mjs')).href);
  for (const mutation of ['bytes', 'mode', 'inode'])
    await t.test(mutation, async (t) => {
      const f = await fixture(t, { config: '# before\n' }),
        path = await f.skill(),
        p = await f.preview((await f.select()).request),
        original = await readFile(path);
      if (mutation === 'bytes')
        await writeFile(path, Buffer.concat([original, Buffer.from('\nchanged')]));
      if (mutation === 'mode') await chmod(path, 0o600);
      if (mutation === 'inode') {
        await rename(path, path + '.old');
        await writeFile(path, original);
      }
      await assert.rejects(
        selected.assertSelectedCandidate(structuredClone(p.privatePlan.candidatePin)),
        { message: 'codex-control-stale' },
      );
      await assert.rejects(f.apply(p.privatePlan), { message: 'codex-control-stale' });
      assert.equal((await f.state()).records.length, 0);
      assert.equal(await readFile(f.target, 'utf8'), '# before\n');
    });
});
test('existing configuration byte and inode drift retain exact stale refusal before intent', async (t) => {
  for (const mutation of ['bytes', 'inode'])
    await t.test(mutation, async (t) => {
      const f = await fixture(t, { config: '# before\n' });
      await f.skill();
      const p = await f.preview((await f.select()).request),
        original = await readFile(f.target);
      if (mutation === 'bytes') await writeFile(f.target, '# after\n');
      else {
        await rename(f.target, f.target + '.old');
        await writeFile(f.target, original);
      }
      await assert.rejects(f.apply(p.privatePlan), { message: 'codex-control-stale' });
      assert.equal((await f.state()).records.length, 0);
    });
});
