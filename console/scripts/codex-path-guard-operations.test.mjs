import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdir, rm, rename, chmod, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  fixture,
  api,
  schema,
  privateSchema,
  original,
} from './codex-path-guard-operations-fixtures.mjs';
test('passive state and capture preserve config and do not mint history or leak private paths', async (t) => {
  const f = await fixture(t),
    s = await f.state(),
    c = await f.capture();
  assert.equal(schema.validateCodexPathGuardState(s), true);
  assert.equal(s.history, 'missing');
  assert.equal(schema.validateCodexPathGuardCapture(c), true);
  assert.equal(c.presets[0].canGuard, true);
  assert.equal(JSON.stringify([s, c]).includes(f.base), false);
  assert.equal(await readFile(f.target, 'utf8'), original);
  await assert.rejects(readFile(join(f.userHome, '.stroq/codex-path-guard/.gitignore')), {
    code: 'ENOENT',
  });
});
test('real Guard and Restore preserve exact bytes and mode for default and custom CODEX_HOME', async (t) => {
  for (const custom of [false, true])
    await t.test(custom ? 'custom' : 'default', async (t) => {
      const f = await fixture(t, { custom }),
        p = await f.preview(await f.select());
      assert.equal(privateSchema.validateCodexPathGuardPrivatePlan(p.privatePlan), true);
      assert.equal(schema.validateCodexPathGuardPreview(p.preview), true);
      const r = await f.apply(p.privatePlan);
      assert.equal((await stat(f.target)).mode & 0o777, 0o640);
      assert.equal(schema.validateCodexPathGuardReceipt(r), true);
      assert.equal(r.record.standing, 'selected');
      assert.equal(r.record.canRestore, true);
      assert.equal(r.record.presetId, 'aws-credentials');
      assert.equal((await f.capture()).presets[0].declaration, 'deny');
      const final = await f.apply((await f.restore(r.record)).privatePlan);
      assert.equal(final.record.operationStatus, 'restored');
      assert.equal(await readFile(f.target, 'utf8'), original);
      assert.equal((await stat(f.target)).mode & 0o777, 0o640);
    });
});
test('Restore preserves later selector, network, unrelated filesystem and comments after target disappearance', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.userHome, '.aws'), { mode: 0o700 });
  await writeFile(join(f.userHome, '.aws/credentials'), 'inert', { mode: 0o600 });
  const r = await f.apply((await f.preview(await f.select())).privatePlan);
  await rm(join(f.userHome, '.aws/credentials'));
  const later =
    (await readFile(f.target, 'utf8'))
      .replace('default_permissions="source"', 'default_permissions=":read-only"')
      .replace('enabled=false', 'enabled=true')
      .replace(
        '[permissions.source]\n',
        '[permissions.source]\nfilesystem."/unrelated/safe"="deny"\n',
      ) + '\n[unrelated]\nkeep=true # later\n';
  await writeFile(f.target, later);
  const p = await f.restore(r.record),
    restored = await f.apply(p.privatePlan);
  assert.equal(restored.record.operationStatus, 'restored');
  const result = await readFile(f.target, 'utf8');
  assert.ok(result.includes('default_permissions=":read-only"'));
  assert.ok(result.includes('enabled=true'));
  assert.ok(result.includes('keep=true # later'));
  assert.ok(result.includes('"/unrelated/safe"="deny"'));
  assert.equal(result.includes('stroq-path-guard'), false);
});
test('closed consent and exact current config/target metadata reject before retained history', async (t) => {
  const f = await fixture(t),
    p = await f.preview(await f.select());
  await assert.rejects(f.run('apply', { privatePlan: p.privatePlan, writerLockHeld: true }), {
    message: 'codex-path-guard-consent-required',
  });
  await writeFile(f.target, original + '# later\n');
  await assert.rejects(f.apply(p.privatePlan), { message: 'codex-path-guard-stale' });
  assert.equal((await f.state()).records.length, 0);
  const g = await fixture(t),
    q = await g.preview(await g.select());
  await mkdir(join(g.userHome, '.aws'), { mode: 0o700 });
  await writeFile(join(g.userHome, '.aws/credentials'), 'inert', { mode: 0o600 });
  await assert.rejects(g.apply(q.privatePlan), { message: 'codex-path-guard-stale' });
  assert.equal((await g.state()).records.length, 0);
});
test('unknown Guard is never retried; exact staged inode recheck completes and foreign equal bytes cannot', async (t) => {
  const f = await fixture(t),
    p = await f.preview(await f.select());
  await assert.rejects(
    f.apply(p.privatePlan, async (stage) => {
      if (stage === 'after-target-rename') throw Error('owned fault');
    }),
    { message: 'codex-path-guard-write-unconfirmed' },
  );
  let r = (await f.state()).records[0];
  assert.equal(r.operationStatus, 'unknown');
  await assert.rejects(f.preview(await f.select('npmrc')), {
    message: 'codex-path-guard-recovery-required',
  });
  const checked = await f.recheck(r);
  assert.equal(checked.writeConfirmed, true);
  assert.equal(checked.record.operationStatus, 'guarded');
  const g = await fixture(t),
    q = await g.preview(await g.select());
  await assert.rejects(
    g.apply(q.privatePlan, async (stage) => {
      if (stage === 'after-intent') throw Error('owned fault');
    }),
    /write-unconfirmed/,
  );
  r = (await g.state()).records[0];
  assert.equal((await g.recheck(r)).writeConfirmed, false);
  await writeFile(g.target, q.privatePlan.candidate);
  r = (await g.state()).records[0];
  assert.equal((await g.recheck(r)).writeConfirmed, false);
});
test('unknown Restore requires its exact operation; completed receipt stays historical', async (t) => {
  const f = await fixture(t),
    guarded = await f.apply((await f.preview(await f.select())).privatePlan),
    p = await f.restore(guarded.record);
  await assert.rejects(
    f.apply(p.privatePlan, async (stage) => {
      if (stage === 'after-target-rename') throw Error('owned fault');
    }),
    /write-unconfirmed/,
  );
  const r = (await f.state()).records[0];
  assert.equal(r.operationId, p.preview.operationId);
  await assert.rejects(f.recheck({ ...r, operationId: guarded.operationId }), {
    message: 'codex-path-guard-stale',
  });
  assert.equal((await f.recheck(r)).record.operationStatus, 'restored');
  await writeFile(f.target, original + '# after\n');
  assert.equal((await f.recheck((await f.state()).records[0])).writeConfirmed, true);
});
test('retained rows survive unavailable native capture and state captures current context once', async (t) => {
  const f = await fixture(t);
  await f.apply((await f.preview(await f.select())).privatePlan);
  const before = f.nativeCaptures,
    s = await f.state();
  assert.equal(s.records.length, 1);
  assert.equal(f.nativeCaptures - before, 1);
  const unavailable = await f.state({
    nativeCapture: async () => {
      throw Error('unavailable');
    },
  });
  assert.equal(unavailable.records.length, 1);
  assert.equal(unavailable.records[0].canRestore, false);
  assert.equal(unavailable.records[0].standing, 'unavailable');
  assert.equal(unavailable.history, 'ready');
});
test('changed parent/native and edited owned leaf refuse without further config writes', async (t) => {
  const f = await fixture(t),
    p = await f.preview(await f.select()),
    parent = dirname(f.target);
  await rename(parent, parent + '-old');
  await mkdir(parent, { mode: 0o700 });
  await rename(join(parent + '-old', 'config.toml'), f.target);
  await assert.rejects(f.apply(p.privatePlan), { message: 'codex-path-guard-stale' });
  assert.equal((await f.state()).records.length, 0);
  const g = await fixture(t),
    q = await g.preview(await g.select());
  await chmod(g.native, 0o500);
  await assert.rejects(g.apply(q.privatePlan), { message: 'codex-path-guard-native-changed' });
  assert.equal((await g.state()).records.length, 0);
  const h = await fixture(t),
    r = await h.apply((await h.preview(await h.select())).privatePlan);
  const edited = (await readFile(h.target, 'utf8')).replace('"deny"', '"read"');
  await writeFile(h.target, edited);
  await assert.rejects(h.restore(r.record), { message: 'codex-path-guard-conflict' });
  assert.equal(await readFile(h.target, 'utf8'), edited);
});
test('forged Restore ownership or preset cannot redirect a retained record operation', async (t) => {
  const f = await fixture(t),
    r = await f.apply((await f.preview(await f.select())).privatePlan),
    p = await f.restore(r.record),
    before = await readFile(f.target);
  for (const edit of [
    (v) => (v.owned.profileName = 'other'),
    (v) => {
      v.preview.presetId = 'npmrc';
      v.owned.targetPath = join(f.userHome, '.npmrc');
    },
  ]) {
    const forged = structuredClone(p.privatePlan);
    edit(forged);
    await assert.rejects(f.apply(forged), { message: 'codex-path-guard-conflict' });
    assert.deepEqual(await readFile(f.target), before);
  }
});
test('a later source or credential metadata change after durable intent cannot publish obsolete config', async (t) => {
  for (const change of ['source', 'target'])
    await t.test(change, async (t) => {
      const f = await fixture(t),
        p = await f.preview(await f.select()),
        before = await readFile(f.target);
      await assert.rejects(
        f.apply(p.privatePlan, async (stage) => {
          if (stage !== (change === 'source' ? 'after-intent' : 'after-staged-intent')) return;
          if (change === 'source') {
            await mkdir(join(f.project, '.codex'), { mode: 0o700 });
            await writeFile(
              join(f.project, '.codex/config.toml'),
              '[permissions.source.filesystem]\n"/unrelated"="deny"\n',
            );
          } else {
            await mkdir(join(f.userHome, '.aws'), { mode: 0o700 });
            await writeFile(join(f.userHome, '.aws/credentials'), 'inert', { mode: 0o600 });
          }
        }),
        { message: 'codex-path-guard-write-unconfirmed' },
      );
      assert.deepEqual(await readFile(f.target), before);
      const record = (await f.state()).records[0];
      assert.equal(record.operationStatus, 'unknown');
      assert.equal((await f.recheck(record)).writeConfirmed, false);
    });
});
test('actual Restore policy refuses reopening an older alias write through a new ancestor read', async (t) => {
  const f = await fixture(t, {
      config: original + '[permissions.source.filesystem]\n"~/.aws/credentials"="write"\n',
    }),
    r = await f.apply((await f.preview(await f.select())).privatePlan);
  const later = (await readFile(f.target, 'utf8')).replace(
    '[permissions.source.filesystem]',
    '[permissions.source.filesystem]\n' + JSON.stringify(f.userHome) + '="read"',
  );
  await writeFile(f.target, later);
  await assert.rejects(f.restore(r.record), { message: 'codex-path-guard-conflict' });
  const state = await f.state();
  assert.equal(state.records[0].canRestore, false);
  assert.equal(await readFile(f.target, 'utf8'), later);
});
test('same-path newer guard permanently supersedes old Restore, and a disjoint preset stays independent', async (t) => {
  const f = await fixture(t),
    r1 = await f.apply((await f.preview(await f.select())).privatePlan);
  await writeFile(f.target, (await readFile(f.target, 'utf8')).replace('"deny"', '"read"'));
  const r2 = await f.apply((await f.preview(await f.select())).privatePlan),
    r3 = await f.apply((await f.preview(await f.select('npmrc'))).privatePlan);
  let rows = (await f.state()).records,
    old = rows.find((r) => r.id === r1.record.id);
  assert.equal(old.ownership, 'superseded');
  assert.equal(rows.find((r) => r.id === r2.record.id).canRestore, true);
  await assert.rejects(f.restore(old), { message: 'codex-path-guard-superseded' });
  await f.apply((await f.restore(r2.record)).privatePlan);
  rows = (await f.state()).records;
  old = rows.find((r) => r.id === r1.record.id);
  assert.equal(old.ownership, 'superseded');
  assert.equal(rows.find((r) => r.id === r3.record.id).canRestore, true);
  await assert.rejects(f.restore(old), { message: 'codex-path-guard-superseded' });
});
test('preview clock uses one anchor and unknown foreign store refuses before any path retention', async (t) => {
  const f = await fixture(t),
    request = await f.select(),
    OriginalDate = Date;
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
    assert.equal(privateSchema.validateCodexPathGuardPrivatePlan(p.privatePlan), true);
  } finally {
    globalThis.Date = OriginalDate;
  }
  const root = join(f.userHome, '.stroq'),
    foreign = join(root, 'codex-network-guard');
  await mkdir(root, { mode: 0o700 });
  await mkdir(foreign, { mode: 0o700 });
  await writeFile(join(foreign, '.gitignore'), 'invalid', { mode: 0o600 });
  const before = await readFile(f.target);
  await assert.rejects(f.preview(await f.select()), {
    message: 'codex-path-guard-recovery-required',
  });
  assert.deepEqual(await readFile(f.target), before);
  await assert.rejects(readFile(join(root, 'codex-path-guard/.gitignore')), { code: 'ENOENT' });
});
