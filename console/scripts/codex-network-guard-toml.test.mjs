import test from 'node:test';
import assert from 'node:assert/strict';
import {
  api,
  operationId,
  bytes,
  text,
  doc,
  profileForms,
  legacyForms,
  enableForms,
} from './codex-network-guard-toml.test-helpers.mjs';
for (const [i, source] of profileForms.entries())
  test('named profile changes only its network leaf, form ' + i, () => {
    const result = api.planCodexNetworkGuard({
      bytes: bytes(source),
      operationId,
      kind: 'profile-network-off',
    });
    const before = doc(source),
      after = doc(text(result.bytes)),
      name = before.default_permissions,
      profile = before.permissions[name];
    assert.equal(result.profileName, name);
    assert.equal(result.owned.parentProfile, null);
    assert.equal(result.owned.childProfile, null);
    assert.equal(result.changesFilesystem, false);
    assert.equal(result.retainsProfileOnRestore, false);
    assert.deepEqual(after, {
      ...before,
      permissions: {
        ...before.permissions,
        [name]: { ...profile, network: { ...(profile.network ?? {}), enabled: false } },
      },
    });
    assert.deepEqual(
      Buffer.from(api.restoreCodexNetworkGuard({ bytes: result.bytes, owned: result.owned })),
      bytes(source),
    );
  });
test('unrestricted profile gets explicit workspace strengthening without copying filesystem settings', () => {
  const source = 'default_permissions=":danger-full-access"\nmodel="preserve"\n';
  const p = api.planCodexNetworkGuard({ bytes: bytes(source), operationId, kind: 'profile-child' });
  assert.equal(p.changesFilesystem, true);
  assert.equal(doc(text(p.bytes)).permissions[p.profileName].extends, ':workspace');
  assert.equal(
    doc(text(api.restoreCodexNetworkGuard({ bytes: p.bytes, owned: p.owned }))).default_permissions,
    ':danger-full-access',
  );
});
for (const [i, source] of legacyForms.entries())
  test(
    'legacy network-only mutates only existing boolean and exact restore returns bytes, form ' + i,
    () => {
      const p = api.planCodexNetworkGuard({
        bytes: bytes(source),
        operationId,
        kind: 'legacy-network-off',
      });
      assert.equal(p.changesFilesystem, false);
      assert.equal(p.retainsProfileOnRestore, false);
      assert.equal(p.profileName, undefined);
      const before = doc(source),
        after = doc(text(p.bytes));
      assert.deepEqual(after, {
        ...before,
        sandbox_workspace_write: { ...before.sandbox_workspace_write, network_access: false },
      });
      assert.deepEqual(
        Buffer.from(api.restoreCodexNetworkGuard({ bytes: p.bytes, owned: p.owned })),
        bytes(source),
      );
    },
  );
for (const [i, source] of enableForms.entries())
  test('legacy enabling workspace preserves roots and temporary exclusions, form ' + i, () => {
    const p = api.planCodexNetworkGuard({
      bytes: bytes(source),
      operationId,
      kind: 'legacy-enable-workspace',
    });
    assert.equal(p.changesFilesystem, true);
    assert.equal(p.retainsProfileOnRestore, false);
    const before = doc(source),
      after = doc(text(p.bytes));
    assert.deepEqual(after, {
      ...before,
      sandbox_mode: 'workspace-write',
      sandbox_workspace_write: { ...(before.sandbox_workspace_write ?? {}), network_access: false },
    });
    assert.deepEqual(
      Buffer.from(api.restoreCodexNetworkGuard({ bytes: p.bytes, owned: p.owned })),
      bytes(source),
    );
  });
test('full-access child supports sealed permissions tables and retains child after restore', () => {
  for (const source of [
    "default_permissions=':danger-full-access'\npermissions={inactive={unknown={keep=42}},}\n",
    '\uFEFFdefault_permissions=":danger-full-access"\r\n[permissions]\r\ninactive={extends=":workspace"}\r\n',
    'default_permissions=":danger-full-access"\npermissions.inactive={network={enabled=true}}\n',
  ]) {
    const before = doc(source),
      p = api.planCodexNetworkGuard({ bytes: bytes(source), operationId, kind: 'profile-child' }),
      child = { extends: ':workspace', network: { enabled: false } };
    assert.deepEqual(doc(text(p.bytes)), {
      ...before,
      default_permissions: p.profileName,
      permissions: { ...before.permissions, [p.profileName]: child },
    });
    assert.deepEqual(doc(text(api.restoreCodexNetworkGuard({ bytes: p.bytes, owned: p.owned }))), {
      ...before,
      permissions: { ...before.permissions, [p.profileName]: child },
    });
  }
});
