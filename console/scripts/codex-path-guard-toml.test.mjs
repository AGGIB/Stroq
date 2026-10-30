import test from 'node:test';
import assert from 'node:assert/strict';
import {
  api,
  operationId,
  targetPath,
  bytes,
  text,
  doc,
  plan,
  forms,
} from './codex-path-guard-toml.test-helpers.mjs';

for (const [index, source] of forms.entries())
  test(`exact path deny preserves all other values and roundtrips layout ${index + 1}`, () => {
    const p = plan(source),
      before = doc(source),
      name = before.default_permissions;
    assert.equal(p.kind, 'profile-path-deny');
    assert.equal(p.profileName, name);
    assert.deepEqual(p.ownedPath, ['permissions', name, 'filesystem', targetPath]);
    assert.deepEqual(p.effect, {
      filesystem: 'deny-exact-path',
      targetReads: 'denied',
      targetWrites: 'denied',
    });
    const expected = {
      ...before,
      permissions: {
        ...before.permissions,
        [name]: {
          ...before.permissions[name],
          filesystem: { ...(before.permissions[name].filesystem ?? {}), [targetPath]: 'deny' },
        },
      },
    };
    assert.deepEqual(doc(text(p.bytes)), expected);
    assert.equal(p.owned.kind, 'profile-path-deny');
    assert.equal(p.owned.targetPath, targetPath);
    assert.equal(p.owned.profileName, name);
    assert.equal(text(api.restoreCodexPathGuard({ bytes: p.bytes, owned: p.owned })), source);
  });
test('broad home and root grants remain unchanged while exact path is denied', () => {
  const source =
    'default_permissions="source"\n[permissions.source.filesystem]\n"/"="read"\n"/fixture/home"="write"\n"/fixture/home/.ssh"="deny"\n';
  const p = plan(source),
    fs = doc(text(p.bytes)).permissions.source.filesystem;
  assert.deepEqual(fs, {
    '/': 'read',
    '/fixture/home': 'write',
    '/fixture/home/.ssh': 'deny',
    [targetPath]: 'deny',
  });
  assert.equal(p.rulesBefore, 3);
});
test('existing exact or ancestor deny is never adopted; narrower prior grants can be closed', () => {
  for (const key of [targetPath, '/fixture/home/.aws'])
    assert.throws(
      () =>
        plan(`default_permissions="source"\n[permissions.source.filesystem]\n"${key}"="deny"\n`),
      /codex-path-guard-already-denied/,
    );
  const p = plan(
    `default_permissions="source"\n[permissions.source.filesystem]\n"/fixture/home/.aws"="deny"\n"${targetPath}"="read"\n`,
  );
  assert.equal(doc(text(p.bytes)).permissions.source.filesystem[targetPath], 'deny');
});
test('exact scoped maps and descendant grants refuse rather than overwrite any subtree', () => {
  for (const value of ['{ "."="read" }', '["read"]', 'true', '1'])
    assert.throws(
      () =>
        plan(
          `default_permissions="source"\n[permissions.source.filesystem]\n"${targetPath}"=${value}\n`,
        ),
      /codex-path-guard-(?:invalid|conflict)/,
    );
  for (const value of ['read', 'write'])
    assert.throws(
      () =>
        plan(
          `default_permissions="source"\n[permissions.source.filesystem]\n"${targetPath}/reopened"="${value}"\n`,
        ),
      /codex-path-guard-conflict/,
    );
});
test('descriptor and returned bytes cannot alias caller buffers', () => {
  const source = bytes(forms[0]),
    p = api.planCodexPathGuard({ bytes: source, operationId, targetPath }),
    candidate = Buffer.from(p.owned.candidate),
    original = Buffer.from(p.owned.before);
  source.fill(0);
  p.bytes.fill(0);
  assert.deepEqual(p.owned.before, original);
  assert.deepEqual(p.owned.candidate, candidate);
});
test('explicit existing named user profile and supported extends shape are required', () => {
  for (const source of [
    null,
    '',
    'permissions={source={}}',
    'default_permissions=1',
    'default_permissions=":workspace"\npermissions={}',
    'default_permissions="missing"\npermissions={source={}}',
    'default_permissions="source"\npermissions={source=[]}',
    'default_permissions="source"\npermissions={source={extends=1}}',
    'default_permissions="source"\npermissions={source={extends={}}}',
    'default_permissions="source"\npermissions={source={filesystem=[]}}',
  ])
    assert.throws(() => plan(source), /codex-path-guard-invalid/);
});
test('reserved filesystem profile cannot be selected or inherited locally', () => {
  for (const source of [
    'default_permissions="filesystem"\n[permissions.filesystem]\nextends=":workspace"\n',
    'default_permissions="source"\n[permissions.source]\nextends="filesystem"\n',
  ])
    assert.throws(() => plan(source), { message: 'codex-path-guard-invalid' });
});
test('strict duplicates, invalid UTF8, limits and unsafe path selectors are finite refusals', () => {
  for (const source of [
    forms[0] + '\n[unrelated]\nx=1\nx=2\n',
    'default_permissions="source"\npermissions={source={}}\nconstructor=1\n',
    'default_permissions="source"\npermissions={source={filesystem={"/x"="read","\\u002fx"="deny"}}}\n',
  ])
    assert.throws(() => plan(source), /codex-path-guard-invalid/);
  assert.throws(
    () => api.planCodexPathGuard({ bytes: Buffer.from([0xc3, 0x28]), operationId, targetPath }),
    /codex-path-guard-invalid/,
  );
  for (const target of [
    '/',
    'relative',
    '~/file',
    '/fixture/../file',
    '/fixture//file',
    '/fixture/file/',
    '/fixture/*.env',
    '/fixture/[x]',
    '/fixture/line\nfile',
  ])
    assert.throws(() => plan(forms[0], { targetPath: target }), /codex-path-guard-invalid/);
  assert.throws(() => plan(forms[0], { operationId: 'bad' }), /codex-path-guard-invalid/);
  assert.throws(
    () =>
      api.planCodexPathGuard({ bytes: Buffer.alloc(256 * 1024 + 1, 32), operationId, targetPath }),
    /codex-path-guard-limit/,
  );
  const prefix = 'default_permissions="source"\npermissions={source={}}\n#';
  assert.throws(
    () => plan(prefix + ' '.repeat(256 * 1024 - Buffer.byteLength(prefix))),
    /codex-path-guard-limit/,
  );
  const fs = Array.from({ length: 513 }, (_, i) => `"/distinct-${i}"="read"`).join('\n');
  assert.throws(
    () => plan('default_permissions="source"\n[permissions.source.filesystem]\n' + fs),
    /codex-path-guard-limit/,
  );
});
