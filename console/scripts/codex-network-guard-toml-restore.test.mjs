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
test('child restoration retains inactive owned child, new references and unrelated profile edits', () => {
  const source =
    'default_permissions=":danger-full-access"\n[permissions.source]\nnetwork={enabled=true}\nfilesystem={read=["old"]}\n';
  const p = api.planCodexNetworkGuard({ bytes: bytes(source), operationId, kind: 'profile-child' });
  const later =
    text(p.bytes).replace('read=["old"]', 'read=["new"]') +
    '\n[permissions.later]\nextends=' +
    JSON.stringify(p.profileName) +
    '\n[other]\nkeep=true\n';
  const restored = text(api.restoreCodexNetworkGuard({ bytes: bytes(later), owned: p.owned }));
  assert.deepEqual(doc(restored), { ...doc(later), default_permissions: ':danger-full-access' });
  assert.ok(restored.includes('read=["new"]'));
  assert.ok(restored.includes('extends=' + JSON.stringify(p.profileName)));
});
test('legacy restore retains unrelated later settings and comments for every layout', () => {
  for (const source of [...legacyForms, ...enableForms]) {
    const kind = source.includes('danger-full-access')
      ? 'legacy-enable-workspace'
      : 'legacy-network-off';
    const p = api.planCodexNetworkGuard({ bytes: bytes(source), operationId, kind });
    const later = text(p.bytes) + '\n[other_later]\nkeep="yes"\n# foreign comment\n';
    const restored = text(api.restoreCodexNetworkGuard({ bytes: bytes(later), owned: p.owned }));
    assert.deepEqual(doc(restored), { ...doc(source), other_later: { keep: 'yes' } });
    assert.ok(restored.includes('# foreign comment'));
  }
});
test('removal of an inserted legacy field preserves new sibling fields and comments', () => {
  const p = api.planCodexNetworkGuard({
    bytes: bytes('sandbox_mode="danger-full-access"\nsandbox_workspace_write={}\n'),
    operationId,
    kind: 'legacy-enable-workspace',
  });
  const later = text(p.bytes).replace(
    'sandbox_workspace_write={',
    'sandbox_workspace_write={writable_roots=["/new"], ',
  );
  const restored = doc(text(api.restoreCodexNetworkGuard({ bytes: bytes(later), owned: p.owned })));
  assert.deepEqual(restored, {
    sandbox_mode: 'danger-full-access',
    sandbox_workspace_write: { writable_roots: ['/new'] },
  });
});
test('related selector, child, boolean, mode and marker changes refuse without rollback', () => {
  const p = api.planCodexNetworkGuard({
      bytes: bytes('default_permissions=":danger-full-access"\n'),
      operationId,
      kind: 'profile-child',
    }),
    s = text(p.bytes);
  for (const current of [
    s.replace(JSON.stringify(p.profileName), '"foreign"'),
    s.replace('enabled = false', 'enabled = true'),
    s.replace('extends = ":workspace"', 'extends = ":read-only"'),
    s.replace('# stroq-network-guard ' + operationId, '# removed'),
    s + '# stroq-network-guard ' + operationId + '\n',
  ])
    assert.throws(
      () => api.restoreCodexNetworkGuard({ bytes: bytes(current), owned: p.owned }),
      /codex-network-guard-conflict/,
    );
  const legacy = api.planCodexNetworkGuard({
    bytes: bytes(enableForms[6]),
    operationId,
    kind: 'legacy-enable-workspace',
  });
  for (const current of [
    text(legacy.bytes)
      .replace('network_access=false', 'network_access=true')
      .replace('network_access = false', 'network_access = true'),
    text(legacy.bytes).replace('"workspace-write"', '"read-only"'),
  ])
    assert.throws(
      () => api.restoreCodexNetworkGuard({ bytes: bytes(current), owned: legacy.owned }),
      /codex-network-guard-conflict/,
    );
  assert.throws(
    () =>
      api.restoreCodexNetworkGuard({
        bytes: p.bytes,
        owned: { ...p.owned, candidate: bytes('forged=true') },
      }),
    /codex-network-guard-conflict/,
  );
});
test('malformed inputs, guessed selectors, collisions, unsafe UTF-8 and finite limits refuse', () => {
  for (const source of [
    null,
    '',
    'permissions={}',
    'default_permissions=1',
    'default_permissions=""',
    'default_permissions=":workspace"',
    'default_permissions="source"\npermissions={source={}}',
    'default_permissions=":danger-full-access"\npermissions=[]',
    'default_permissions=":danger-full-access"\nx=1\nx=2',
    'default_permissions=":danger-full-access"\nconstructor=1',
  ])
    assert.throws(
      () => api.planCodexNetworkGuard({ bytes: bytes(source), operationId, kind: 'profile-child' }),
      /codex-network-guard-invalid/,
    );
  for (const source of [
    'sandbox_mode="workspace-write"',
    'sandbox_workspace_write={network_access=false}',
    'default_permissions=":workspace"\nsandbox_workspace_write={network_access=true}',
    'sandbox_workspace_write={network_access="true"}',
  ])
    assert.throws(
      () =>
        api.planCodexNetworkGuard({
          bytes: bytes(source),
          operationId,
          kind: 'legacy-network-off',
        }),
      /codex-network-guard-invalid/,
    );
  assert.throws(
    () =>
      api.planCodexNetworkGuard({
        bytes: bytes('sandbox_mode="workspace-write"'),
        operationId,
        kind: 'legacy-enable-workspace',
      }),
    /codex-network-guard-invalid/,
  );
  assert.throws(
    () =>
      api.planCodexNetworkGuard({
        bytes: bytes(
          'default_permissions=":danger-full-access"\npermissions={"stroq-network-' +
            operationId +
            '"={}}',
        ),
        operationId,
        kind: 'profile-child',
      }),
    /codex-network-guard-conflict/,
  );
  assert.throws(
    () =>
      api.planCodexNetworkGuard({
        bytes: Buffer.from([0xc3, 0x28]),
        operationId,
        kind: 'profile-child',
      }),
    /codex-network-guard-invalid/,
  );
  assert.throws(
    () =>
      api.planCodexNetworkGuard({
        bytes: bytes(profileForms[0]),
        operationId: 'bad',
        kind: 'profile-network-off',
      }),
    /codex-network-guard-invalid/,
  );
  assert.throws(
    () =>
      api.planCodexNetworkGuard({
        bytes: Buffer.alloc(256 * 1024 + 1, 32),
        operationId,
        kind: 'profile-child',
      }),
    /codex-network-guard-limit/,
  );
  assert.throws(
    () =>
      api.planCodexNetworkGuard({
        bytes: bytes(
          'default_permissions=":danger-full-access"\nvalues=[' +
            Array.from({ length: 16384 }, () => 1).join(',') +
            ']',
        ),
        operationId,
        kind: 'profile-child',
      }),
    /codex-network-guard-limit/,
  );
  assert.throws(
    () =>
      api.planCodexNetworkGuard({
        bytes: bytes(
          'default_permissions=":danger-full-access"\nv=' + '['.repeat(33) + '0' + ']'.repeat(33),
        ),
        operationId,
        kind: 'profile-child',
      }),
    /codex-network-guard-(?:invalid|limit)/,
  );
});
test('inline removal preserves foreign comments and new fields after original absence', () => {
  const source = 'sandbox_mode="danger-full-access"\nsandbox_workspace_write={}\n';
  const p = api.planCodexNetworkGuard({
    bytes: bytes(source),
    operationId,
    kind: 'legacy-enable-workspace',
  });
  const later = text(p.bytes).replace(
    'network_access = false',
    '\n# foreign inside inline\nnetwork_access = false # trailing foreign\n',
  );
  const restored = text(api.restoreCodexNetworkGuard({ bytes: bytes(later), owned: p.owned }));
  assert.ok(restored.includes('# foreign inside inline'));
  assert.ok(restored.includes('# trailing foreign'));
  assert.deepEqual(doc(restored), doc(source));
  const absent = api.planCodexNetworkGuard({
    bytes: bytes('sandbox_mode="danger-full-access"\n'),
    operationId,
    kind: 'legacy-enable-workspace',
  });
  const edited = text(absent.bytes).replace(
    '{ network_access = false }',
    '{\n# keep new sibling\nwritable_roots=["new"],network_access = false\n}',
  );
  const undo = text(api.restoreCodexNetworkGuard({ bytes: bytes(edited), owned: absent.owned }));
  assert.ok(undo.includes('# keep new sibling'));
  assert.deepEqual(doc(undo), {
    sandbox_mode: 'danger-full-access',
    sandbox_workspace_write: { writable_roots: ['new'] },
  });
});
test('fake owned text in string values never redirects restoration and profile comments may evolve', () => {
  const source = 'default_permissions=":danger-full-access"\n';
  const p = api.planCodexNetworkGuard({ bytes: bytes(source), operationId, kind: 'profile-child' });
  const later =
    text(p.bytes).replace('enabled = false', 'enabled = false # user comment') +
    "\n[other]\nnote='''# stroq-network-guard " +
    operationId +
    "\ndefault_permissions=\"fake\"\n'''\n";
  const restored = text(api.restoreCodexNetworkGuard({ bytes: bytes(later), owned: p.owned }));
  assert.ok(restored.includes('# user comment'));
  assert.deepEqual(doc(restored).other, doc(later).other);
  assert.equal(doc(restored).default_permissions, ':danger-full-access');
  const changed =
    text(p.bytes) + '\n[permissions."' + p.profileName + '".filesystem]\nwrite=["new"]\n';
  assert.throws(
    () => api.restoreCodexNetworkGuard({ bytes: bytes(changed), owned: p.owned }),
    /codex-network-guard-conflict/,
  );
});
test('candidate expansion is byte bounded and ownership does not alias mutable caller buffers', () => {
  const prefix = 'default_permissions=":danger-full-access"\n#';
  const full = prefix + ' '.repeat(256 * 1024 - Buffer.byteLength(prefix));
  assert.throws(
    () => api.planCodexNetworkGuard({ bytes: bytes(full), operationId, kind: 'profile-child' }),
    /codex-network-guard-limit/,
  );
  const source = bytes('default_permissions=":danger-full-access"\n'),
    p = api.planCodexNetworkGuard({ bytes: source, operationId, kind: 'profile-child' });
  source.fill(0);
  assert.equal(text(p.owned.before), 'default_permissions=":danger-full-access"\n');
  const candidate = Buffer.from(p.owned.candidate);
  p.bytes.fill(0);
  assert.deepEqual(p.owned.candidate, candidate);
  assert.throws(
    () =>
      api.restoreCodexNetworkGuard({
        bytes: candidate,
        owned: { ...p.owned, parentProfile: ':read-only' },
      }),
    /codex-network-guard-conflict/,
  );
  assert.throws(
    () => api.restoreCodexNetworkGuard({ bytes: candidate, owned: { ...p.owned, extra: true } }),
    /codex-network-guard-conflict/,
  );
});
test('an unsupported selected named parent cannot become child inheritance', () => {
  const source = 'default_permissions="stroq-network-' + operationId + '"\n';
  assert.throws(
    () => api.planCodexNetworkGuard({ bytes: bytes(source), operationId, kind: 'profile-child' }),
    /codex-network-guard-invalid/,
  );
});
test('in-place restoration permits later selector, parent, filesystem and root edits', () => {
  const source =
    'default_permissions="source"\npermissions={source={extends="parent",network={enabled=true,unknown="keep"},filesystem={read=["old"]},workspace_roots=["old"]},other={}}\n';
  const p = api.planCodexNetworkGuard({
    bytes: bytes(source),
    operationId,
    kind: 'profile-network-off',
  });
  const later = text(p.bytes)
    .replace('default_permissions="source"', 'default_permissions="other"')
    .replace('extends="parent"', 'extends="newparent"')
    .replaceAll('["old"]', '["new"]');
  const after = doc(later),
    restored = doc(text(api.restoreCodexNetworkGuard({ bytes: bytes(later), owned: p.owned })));
  assert.deepEqual(restored, {
    ...after,
    permissions: {
      ...after.permissions,
      source: {
        ...after.permissions.source,
        network: { ...after.permissions.source.network, enabled: true },
      },
    },
  });
  assert.throws(
    () =>
      api.restoreCodexNetworkGuard({
        bytes: bytes(text(p.bytes).replace('enabled=false', 'enabled=true')),
        owned: p.owned,
      }),
    /codex-network-guard-conflict/,
  );
});
test('network-only restoration preserves a later mode change and other inactive profile edits', () => {
  const source =
    'sandbox_mode="workspace-write"\nsandbox_workspace_write={network_access=true,writable_roots=["keep"]}\npermissions={inactive={extends=":workspace"}}\n';
  const p = api.planCodexNetworkGuard({
    bytes: bytes(source),
    operationId,
    kind: 'legacy-network-off',
  });
  const later = text(p.bytes)
    .replace('sandbox_mode="workspace-write"', 'sandbox_mode="read-only"')
    .replace('inactive={extends=":workspace"}', 'inactive={extends=":read-only"}');
  const restored = doc(text(api.restoreCodexNetworkGuard({ bytes: bytes(later), owned: p.owned })));
  assert.deepEqual(restored, {
    ...doc(later),
    sandbox_workspace_write: { ...doc(later).sandbox_workspace_write, network_access: true },
  });
});
test('in-place inserted network fields restore across layouts while retaining unrelated later bytes', () => {
  for (const source of profileForms) {
    const p = api.planCodexNetworkGuard({
      bytes: bytes(source),
      operationId,
      kind: 'profile-network-off',
    });
    const later = text(p.bytes) + '\n[foreign_later]\nkeep=true\n# retained later comment\n';
    const restored = text(api.restoreCodexNetworkGuard({ bytes: bytes(later), owned: p.owned }));
    assert.deepEqual(doc(restored), { ...doc(source), foreign_later: { keep: true } });
    assert.ok(restored.includes('# retained later comment'));
  }
  const source = 'default_permissions="source"\npermissions={source={}}\n';
  const p = api.planCodexNetworkGuard({
    bytes: bytes(source),
    operationId,
    kind: 'profile-network-off',
  });
  const current = text(p.bytes).replace(
    '"network"."enabled" = false',
    'network = { enabled=false, allowed_domains=["later"] }',
  );
  const restored = text(api.restoreCodexNetworkGuard({ bytes: bytes(current), owned: p.owned }));
  assert.deepEqual(doc(restored), {
    default_permissions: 'source',
    permissions: { source: { network: { allowed_domains: ['later'] } } },
  });
});
test('only an explicit named existing user profile with a boolean or missing network leaf is eligible', () => {
  for (const source of [
    'default_permissions=":workspace"\npermissions={}',
    'default_permissions="missing"\npermissions={}',
    'default_permissions="source"\npermissions={source=[]}',
    'default_permissions="source"\npermissions={source={network=[]}}',
    'default_permissions="source"\npermissions={source={network={enabled="true"}}}',
    'default_permissions="source"\npermissions={source={network={enabled=false}}}',
  ])
    assert.throws(
      () =>
        api.planCodexNetworkGuard({
          bytes: bytes(source),
          operationId,
          kind: 'profile-network-off',
        }),
      /codex-network-guard-invalid/,
    );
});
