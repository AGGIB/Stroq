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
  test(`owned leaf Restore preserves unrelated later bytes for layout ${index + 1}`, () => {
    const p = plan(source),
      later = text(p.bytes) + '\n[foreign_later]\nkeep="Не менять"\n# retained foreign comment\n',
      restored = text(api.restoreCodexPathGuard({ bytes: bytes(later), owned: p.owned }));
    assert.deepEqual(doc(restored), { ...doc(source), foreign_later: { keep: 'Не менять' } });
    assert.ok(restored.includes('# retained foreign comment'));
    assert.ok(restored.includes('keep="Не менять"'));
  });
test('later selector, parent, network and disjoint filesystem edits survive Restore', () => {
  const source = `default_permissions="source"\n[permissions.source]\nextends="parent"\n[permissions.source.filesystem]\n"${targetPath}"="read"\n"/independent"="deny"\n[permissions.source.network]\nenabled=false\n`,
    p = plan(source);
  const later = text(p.bytes)
    .replace('default_permissions="source"', 'default_permissions="other"')
    .replace('extends="parent"', 'extends="new-parent"')
    .replace('enabled=false', 'enabled=true')
    .replace('"/independent"="deny"', '"/independent"="deny"\n"/new-deny"="deny"');
  const restored = doc(text(api.restoreCodexPathGuard({ bytes: bytes(later), owned: p.owned }))),
    expected = doc(later);
  expected.permissions.source.filesystem[targetPath] = 'read';
  assert.deepEqual(restored, expected);
  assert.equal(restored.default_permissions, 'other');
});
test('new local ancestor denial cannot be bypassed by restoring an older exact grant', () => {
  const source = `default_permissions="source"\n[permissions.source.filesystem]\n"${targetPath}"="read"\n`,
    p = plan(source),
    later = text(p.bytes).replace(
      '[permissions.source.filesystem]',
      '[permissions.source.filesystem]\n"/fixture/home/.aws"="deny"',
    );
  assert.throws(
    () => api.restoreCodexPathGuard({ bytes: bytes(later), owned: p.owned }),
    /codex-path-guard-conflict/,
  );
});
test('removing an inserted leaf reveals current ancestor deny rather than reintroducing a grant', () => {
  const source =
      'default_permissions="source"\n[permissions.source.filesystem]\n"/independent"="deny"\n',
    p = plan(source),
    later = text(p.bytes).replace(
      '[permissions.source.filesystem]',
      '[permissions.source.filesystem]\n"/fixture/home/.aws"="deny"',
    );
  const restored = doc(text(api.restoreCodexPathGuard({ bytes: bytes(later), owned: p.owned })));
  assert.deepEqual(restored.permissions.source.filesystem, {
    '/independent': 'deny',
    '/fixture/home/.aws': 'deny',
  });
});
test('inserted inline leaf removal preserves new sibling denies and comments', () => {
  const source = 'default_permissions="source"\npermissions={source={}}\n',
    p = plan(source),
    needle = '"filesystem".' + JSON.stringify(targetPath) + ' = "deny"';
  const later = text(p.bytes).replace(
    needle,
    'filesystem={\n# preserve sibling\n"/new-deny"="deny", ' +
      JSON.stringify(targetPath) +
      '="deny" # own trailing comment\n}',
  );
  assert.notEqual(later, text(p.bytes));
  const restored = text(api.restoreCodexPathGuard({ bytes: bytes(later), owned: p.owned }));
  assert.ok(restored.includes('# preserve sibling'));
  assert.ok(restored.includes('# own trailing comment'));
  assert.deepEqual(doc(restored).permissions.source.filesystem, { '/new-deny': 'deny' });
});
test('same-key value/shape edits and missing/duplicate/indented markers cannot become Restore authority', () => {
  const p = plan(forms[0]),
    s = text(p.bytes),
    marker = '# stroq-path-guard ' + operationId;
  for (const current of [
    s.replace('"deny" # owned value comment', '"read" # owned value comment'),
    s.replace('"deny" # owned value comment', "'deny' # owned value comment"),
    s.replace('"deny" # owned value comment', '{ "."="deny" } # owned value comment'),
    s.replace(marker, '# removed'),
    s + marker + '\n',
    s.replace(marker, '  ' + marker),
  ])
    assert.throws(
      () => api.restoreCodexPathGuard({ bytes: bytes(current), owned: p.owned }),
      /codex-path-guard-conflict/,
    );
});
test('fake owner text in strings never redirects exact marker removal', () => {
  const marker = '# stroq-path-guard ' + operationId,
    source = `default_permissions="source"\npermissions={source={}}\n[other]\nnote='''${marker}\n'''\n`,
    p = plan(source),
    later = text(p.bytes) + "\n[another]\nnote='''" + marker + "\n'''\n",
    restored = text(api.restoreCodexPathGuard({ bytes: bytes(later), owned: p.owned }));
  assert.deepEqual(doc(restored), { ...doc(source), another: { note: marker + '\n' } });
  assert.equal(restored.split(marker).length - 1, 2);
});
test('foreign comment suffix cannot redirect marker removal after owned line-ending formatting', () => {
  const marker = '# stroq-path-guard ' + operationId,
    p = plan(forms[0]),
    foreign = '# foreign retained ' + marker + '\n',
    later = text(p.bytes).replace(marker + '\n', marker + '\r\n') + '\n' + foreign;
  const restored = text(api.restoreCodexPathGuard({ bytes: bytes(later), owned: p.owned }));
  assert.ok(restored.includes(foreign));
  assert.equal(restored.split(marker).length - 1, 1);
  assert.equal(doc(restored).permissions.source.filesystem[targetPath], 'read');
});
test('forged ownership cannot adopt an equal fragment, different path or profile', () => {
  const p = plan(forms[0]);
  for (const owned of [
    { ...p.owned, extra: true },
    { ...p.owned, kind: 'profile-child' },
    { ...p.owned, profileName: 'other' },
    { ...p.owned, targetPath: '/other' },
    { ...p.owned, candidate: bytes('forged=true') },
    { ...p.owned, before: bytes('forged=true') },
    { ...p.owned, operationId: 'bad' },
  ])
    assert.throws(
      () => api.restoreCodexPathGuard({ bytes: p.bytes, owned }),
      /codex-path-guard-conflict/,
    );
  const symbol = Symbol('extra');
  assert.throws(
    () => api.restoreCodexPathGuard({ bytes: p.bytes, owned: { ...p.owned, [symbol]: true } }),
    /codex-path-guard-conflict/,
  );
});
test('candidate rule limit is bounded as well as input rule count', () => {
  const source =
    'default_permissions="source"\n[permissions.source.filesystem]\n' +
    Array.from({ length: 512 }, (_, i) => `"/independent-${i}"="deny"`).join('\n');
  assert.throws(() => plan(source), /codex-path-guard-limit/);
});
test('quoted Unicode exact selectors preserve decoded key and unrelated scalar bytes', () => {
  const target = '/fixture/ключ с пробелом/quote"file',
    source =
      'default_permissions="source.with.dot"\n[permissions."source.with.dot"]\nextends=":workspace"\n[other]\nbig=9_223_372_036_854_775_807\nwhen=1979-05-27T07:32:00.999Z\n',
    p = plan(source, { targetPath: target });
  assert.equal(doc(text(p.bytes)).permissions['source.with.dot'].filesystem[target], 'deny');
  assert.ok(text(p.bytes).includes('big=9_223_372_036_854_775_807'));
  assert.equal(text(api.restoreCodexPathGuard({ bytes: p.bytes, owned: p.owned })), source);
});
