import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { parse } from 'smol-toml';
const loader = await mkdtemp(join(tmpdir(), 'stroq-skill-toml-loader-'));
after(() => rm(loader, { recursive: true, force: true }));
const tsconfig = join(loader, 'tsconfig.json');
await writeFile(
  tsconfig,
  JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
  }),
);
const api = await tsImport('./codex-skill-control-toml.ts', {
  parentURL: import.meta.url,
  tsconfig,
});
const operationId = '00000000-0000-4000-8000-000000000001';
const documentPath = '/fixture/.agents/skills/notes/SKILL.md';
const bytes = (s) => (s === null ? null : Buffer.from(s));
const normalized = (v) =>
  Array.isArray(v)
    ? v.map(normalized)
    : v &&
        typeof v === 'object' &&
        (Object.getPrototypeOf(v) === null || Object.getPrototypeOf(v) === Object.prototype)
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalized(x)]))
      : v;
const doc = (s) =>
  normalized(
    parse(s.replace(/^\uFEFF/, ''), {
      integersAsBigInt: true,
      unsafeKeyBehaviour: 'throw',
      maxDepth: 32,
    }),
  );
const forms = [
  null,
  '',
  '# original comment\nmodel="fixture"',
  '[skills]\nother=true\n',
  '[[skills.config]]\nname="other"\nenabled=true\n# keep target comments\n',
  '[skills]\nconfig=[]\n',
  'skills.config = [{ name="other", enabled=true }] # keep\n',
  '"skills"."config"=[{path="/other/SKILL.md",enabled=false},]\n',
  'skills={config=[{name="other",enabled=true}], other={x=42}}\n',
  'skills = { other = "preserve" }\n',
  'skills = {}\n',
  '\uFEFF# keep\r\n[skills]\r\nconfig=[\r\n {name="other",enabled=true}, # keep row\r\n]\r\n',
  'description="""fake [[skills.config]]\npath="fake"\nenabled=true\n"""\n[skills]\nconfig=[{name="other",enabled=true}]\n',
  'description=\'\'\'fake skills={config=[]}\n# text\n\'\'\'\n"skills"={"config"=[],other="x"}\n',
  'skills . config = [# first comment\n {name="other",enabled=true} # last row comment\n ]\n',
  'skills.other = "preserve"\n[another]\nvalue=1_000_000_000_000_000_001\n',
  '[skills]\nconfig=[{name="\uFEFF",enabled=true}]\n',
  '[["skills".\'config\']]\nname="other"\nenabled=true\n[skills.config.options]\nkeep=true\n',
  '"skills.config"=[]\n["other.dot"]\nkeep=42\n',
  '[skills.other]\nkeep="preserve implicit parent"\n',
  'description="""one quote \" two quotes \"\" and a final quote\""""\n[skills]\nconfig=[]\n',
  "description='''literal final two quotes'''''\n[skills]\nconfig=[]\n",
];
for (const [i, source] of forms.entries())
  test('disable is insertion-only and exact restore preserves form ' + i, () => {
    const result = api.planCodexSkillDisable({ bytes: bytes(source), documentPath, operationId });
    const text = Buffer.from(result.bytes).toString('utf8'),
      before = source === null ? {} : doc(source),
      after = doc(text);
    assert.deepEqual(after.skills.config.at(-1), { path: documentPath, enabled: false });
    const expected = {
      ...before,
      skills: {
        ...(before.skills ?? {}),
        config: [...(before.skills?.config ?? []), { path: documentPath, enabled: false }],
      },
    };
    assert.deepEqual(after, expected);
    let at = 0;
    for (const char of source ?? '') {
      at = text.indexOf(char, at);
      assert.ok(at >= 0, 'existing bytes are never removed');
      at++;
    }
    const restored = api.restoreCodexSkillDisable({ bytes: result.bytes, owned: result.owned });
    if (source === null) assert.equal(restored, null);
    else assert.deepEqual(Buffer.from(restored), Buffer.from(source));
  });
test('restore preserves unrelated settings and newer selector rows', () => {
  for (const source of [
    'model="old"\n',
    '[skills]\nconfig=[{name="other",enabled=true}]\n',
    'skills={config=[],other=true}\n',
  ]) {
    const p = api.planCodexSkillDisable({ bytes: bytes(source), documentPath, operationId });
    let current = Buffer.from(p.bytes).toString('utf8').replace('model="old"', 'model="new"');
    // New global table does not become a field of the last skills.config row.
    current += '\n[newer]\nkeep="yes"\n';
    const restored = Buffer.from(
      api.restoreCodexSkillDisable({ bytes: bytes(current), owned: p.owned }),
    ).toString('utf8');
    const parsed = doc(restored);
    assert.equal(parsed.newer.keep, 'yes');
    assert.equal(parsed.model, source.startsWith('model') ? 'new' : undefined);
    assert.deepEqual(parsed.skills?.config ?? [], doc(source).skills?.config ?? []);
  }
  const p = api.planCodexSkillDisable({
    bytes: bytes('[skills]\nconfig=[]\n'),
    documentPath,
    operationId,
  });
  const t = Buffer.from(p.bytes).toString('utf8');
  const updated = t.replace('enabled = false }', 'enabled = false }, {name="later", enabled=true}');
  const restored = doc(
    Buffer.from(api.restoreCodexSkillDisable({ bytes: bytes(updated), owned: p.owned })).toString(
      'utf8',
    ),
  );
  assert.deepEqual(restored.skills.config, [{ name: 'later', enabled: true }]);
});
test('restore refuses changed owned row, prior declarations, missing or duplicate marker and forged ownership', () => {
  const p = api.planCodexSkillDisable({
    bytes: bytes('[skills]\nconfig=[{name="prior",enabled=true}]\n'),
    documentPath,
    operationId,
  });
  const text = Buffer.from(p.bytes).toString('utf8');
  for (const changed of [
    text.replace('enabled = false', 'enabled = true'),
    text.replace('name="prior"', 'name="changed"'),
    text.replace('# stroq-skill-control ' + operationId, '# removed'),
    text + '# stroq-skill-control ' + operationId + '\n',
  ])
    assert.throws(
      () => api.restoreCodexSkillDisable({ bytes: bytes(changed), owned: p.owned }),
      /codex-skill-control-conflict/,
    );
  assert.throws(
    () =>
      api.restoreCodexSkillDisable({
        bytes: p.bytes,
        owned: { ...p.owned, candidate: bytes('model="forged"') },
      }),
    /codex-skill-control-conflict/,
  );
});
test('strict grammar, schemas, paths, IDs and finite limits refuse before mutation', () => {
  for (const source of [
    'skills=1',
    '[skills]\nconfig=true',
    '[skills]\nconfig=[{path="x",enabled="false"}]',
    'x=1\nx=2',
    '[skills]\nconfig=[{path="x",name="both",enabled=false}]',
    'constructor=1',
  ])
    assert.throws(
      () => api.planCodexSkillDisable({ bytes: bytes(source), documentPath, operationId }),
      /codex-skill-control-invalid/,
    );
  for (const path of [
    'relative/SKILL.md',
    '/fixture/../x/SKILL.md',
    '/fixture/file.txt',
    '/fixture/\u0000/SKILL.md',
    '/fixture/\ud800/SKILL.md',
  ])
    assert.throws(
      () => api.planCodexSkillDisable({ bytes: bytes(''), documentPath: path, operationId }),
      /codex-skill-control-invalid/,
    );
  assert.throws(
    () =>
      api.planCodexSkillDisable({ bytes: Buffer.from([0xc3, 0x28]), documentPath, operationId }),
    /codex-skill-control-invalid/,
  );
  assert.throws(
    () =>
      api.planCodexSkillDisable({
        bytes: Buffer.alloc(256 * 1024 + 1, 32),
        documentPath,
        operationId,
      }),
    /codex-skill-control-limit/,
  );
  const source =
    '[skills]\nconfig=[' +
    Array.from({ length: 512 }, (_, i) => '{name="n' + i + '",enabled=false}').join(',') +
    ']';
  assert.throws(
    () => api.planCodexSkillDisable({ bytes: bytes(source), documentPath, operationId }),
    /codex-skill-control-limit/,
  );
});
test('native-looking source text in strings and unrelated table paths never becomes the target', () => {
  const source =
    'note="""[[skills.config]]\npath="fake"\nenabled=false\n"""\n[unrelated]\nskills={config=[{name="do not edit",enabled=true}]}\n';
  const p = api.planCodexSkillDisable({ bytes: bytes(source), documentPath, operationId });
  const text = Buffer.from(p.bytes).toString('utf8');
  assert.ok(text.startsWith(source));
  assert.deepEqual(doc(text).unrelated, doc(source).unrelated);
  const later =
    text +
    "\n[other]\ncopy=''' # stroq-skill-control " +
    operationId +
    '\n{ path = "' +
    documentPath +
    "\", enabled = false }\n'''\n";
  const restored = Buffer.from(
    api.restoreCodexSkillDisable({ bytes: bytes(later), owned: p.owned }),
  ).toString('utf8');
  assert.deepEqual(doc(restored).other, doc(later).other);
  assert.equal(doc(restored).skills, undefined);
});
test('AoT restore preserves later native selectors, dates, large integers and comments', () => {
  const source =
    'when=1979-05-27T07:32:00.999Z\ninteger=9_223_372_036_854_775_807\n[[skills.config]]\nname="old"\nenabled=true\n';
  const p = api.planCodexSkillDisable({ bytes: bytes(source), documentPath, operationId });
  const later =
    Buffer.from(p.bytes).toString('utf8') +
    '# newer selector\n[[skills.config]]\nname="new"\nenabled=false\n';
  const restored = Buffer.from(
    api.restoreCodexSkillDisable({ bytes: bytes(later), owned: p.owned }),
  ).toString('utf8');
  assert.ok(restored.includes('# newer selector'));
  assert.deepEqual(doc(restored), {
    ...doc(source),
    skills: {
      config: [
        { name: 'old', enabled: true },
        { name: 'new', enabled: false },
      ],
    },
  });
});
test('inline restore retains every original comment even when a newer element prevents exact inverse', () => {
  const source = '[skills]\nconfig=[\n{name="prior",enabled=true} # belongs to prior\n]\n';
  const p = api.planCodexSkillDisable({ bytes: bytes(source), documentPath, operationId });
  let current = Buffer.from(p.bytes)
    .toString('utf8')
    .replace(
      'enabled = false }',
      'enabled = false }, # belongs to new\n {name="new",enabled=true}',
    );
  current += '\n[elsewhere]\nvalue="new"\n';
  const restored = Buffer.from(
    api.restoreCodexSkillDisable({ bytes: bytes(current), owned: p.owned }),
  ).toString('utf8');
  assert.ok(restored.includes('# belongs to prior'));
  assert.ok(restored.includes('# belongs to new'));
  assert.deepEqual(doc(restored).skills.config, [
    { name: 'prior', enabled: true },
    { name: 'new', enabled: true },
  ]);
});
test('non-ASCII and quoted path bytes round-trip; mutation does not alias input or ownership buffers', () => {
  const source = bytes('# UTF-8\nmodel="caf\u00e9"\n'),
    path = '/fixture/\u00e9/\u{1f680}/quote"and\\slash/SKILL.md';
  const p = api.planCodexSkillDisable({ bytes: source, documentPath: path, operationId });
  assert.equal(doc(Buffer.from(p.bytes).toString('utf8')).skills.config[0].path, path);
  source.fill(0);
  assert.equal(Buffer.from(p.owned.before).toString('utf8'), '# UTF-8\nmodel="caf\u00e9"\n');
  const originalCandidate = Buffer.from(p.owned.candidate);
  p.bytes.fill(0);
  assert.deepEqual(p.owned.candidate, originalCandidate);
});
test('an owned no-newline creation restores safely after another root setting is added', () => {
  const p = api.planCodexSkillDisable({ bytes: bytes('model="old"'), documentPath, operationId });
  const current = Buffer.from(p.bytes).toString('utf8') + '\n[other]\nkeep=1\n';
  const restored = Buffer.from(
    api.restoreCodexSkillDisable({ bytes: bytes(current), owned: p.owned }),
  ).toString('utf8');
  assert.deepEqual(doc(restored), { model: 'old', other: { keep: 1n } });
});
test('finite node/depth/candidate-byte limits and invalid operation IDs are explicit', () => {
  for (const id of ['bad', '00000000-0000-4000-8000-00000000000A', null])
    assert.throws(
      () => api.planCodexSkillDisable({ bytes: bytes(''), documentPath, operationId: id }),
      /codex-skill-control-invalid/,
    );
  const many = 'values=[' + Array.from({ length: 16384 }, () => 1).join(',') + ']';
  assert.throws(
    () => api.planCodexSkillDisable({ bytes: bytes(many), documentPath, operationId }),
    /codex-skill-control-limit/,
  );
  const deep = 'value=' + '['.repeat(33) + '0' + ']'.repeat(33);
  assert.throws(
    () => api.planCodexSkillDisable({ bytes: bytes(deep), documentPath, operationId }),
    /codex-skill-control-(?:invalid|limit)/,
  );
  const nearlyFull = '#' + ' '.repeat(256 * 1024 - 2) + '\n';
  assert.throws(
    () => api.planCodexSkillDisable({ bytes: bytes(nearlyFull), documentPath, operationId }),
    /codex-skill-control-limit/,
  );
  const full =
    '[skills]\nconfig=[' +
    Array.from({ length: 511 }, (_, i) => '{name="n' + i + '",enabled=false}').join(',') +
    ']';
  const p = api.planCodexSkillDisable({ bytes: bytes(full), documentPath, operationId });
  assert.equal(doc(Buffer.from(p.bytes).toString('utf8')).skills.config.length, 512);
  assert.deepEqual(
    Buffer.from(api.restoreCodexSkillDisable({ bytes: p.bytes, owned: p.owned })),
    bytes(full),
  );
});
test('restore of an earlier owned disable retains later owned rows and their marker', () => {
  const first = api.planCodexSkillDisable({
    bytes: bytes('[skills]\nconfig=[]\n'),
    documentPath,
    operationId,
  });
  const nextId = '00000000-0000-4000-8000-000000000002',
    nextPath = '/fixture/second/SKILL.md';
  const second = api.planCodexSkillDisable({
    bytes: first.bytes,
    documentPath: nextPath,
    operationId: nextId,
  });
  const restored = Buffer.from(
    api.restoreCodexSkillDisable({ bytes: second.bytes, owned: first.owned }),
  ).toString('utf8');
  assert.deepEqual(doc(restored).skills.config, [{ path: nextPath, enabled: false }]);
  assert.ok(restored.includes('# stroq-skill-control ' + nextId));
  assert.ok(!restored.includes('# stroq-skill-control ' + operationId));
});
test('an inline table created config field retains later rules and independent fields', () => {
  const first = api.planCodexSkillDisable({
    bytes: bytes('skills={}\n'),
    documentPath,
    operationId,
  });
  const current = Buffer.from(first.bytes)
    .toString('utf8')
    .replace('enabled = false }]', 'enabled = false }, {name="new",enabled=true}]')
    .replace('skills={', 'skills={other=42, ');
  const restored = Buffer.from(
    api.restoreCodexSkillDisable({ bytes: bytes(current), owned: first.owned }),
  ).toString('utf8');
  assert.deepEqual(doc(restored).skills, { other: 42n, config: [{ name: 'new', enabled: true }] });
});
