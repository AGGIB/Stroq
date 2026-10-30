import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'tsup';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-codex-capture-build-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    capture: join(repository, 'console/scripts/codex-skill-source-capture.ts'),
    context: join(repository, 'console/scripts/codex-skill-source-context.ts'),
    schema: join(repository, 'console/lib/codex-skill-sources.ts'),
    worker: join(repository, 'console/scripts/inventory-worker.ts'),
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
const capture = await import(pathToFileURL(join(output, 'capture.mjs')).href);
const contexts = await import(pathToFileURL(join(output, 'context.mjs')).href);
const schema = await import(pathToFileURL(join(output, 'schema.mjs')).href);
const content = (name = 'notes') =>
  `---\nname: ${name}\ndescription: Summarize release notes.\n---\nSummarize release changes.\n`;
const runtimeSha256 = 'a'.repeat(64);
async function fixture(t, { repo = true } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-codex-capture-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const top = join(base, 'repository'),
    project = join(top, 'child'),
    userHome = join(base, 'user'),
    home = join(userHome, '.stroq');
  await mkdir(project, { recursive: true });
  await mkdir(userHome);
  if (repo) await mkdir(join(top, '.git'));
  const options = { project, userHome, runtimeSha256, deadline: Date.now() + 15000 };
  async function skill(root, locator, text = content()) {
    const folder = join(root, '.agents', 'skills', locator);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'SKILL.md'), text);
    return folder;
  }
  async function legacy(root, locator, text = content()) {
    const folder = join(root, '.codex', 'skills', locator);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'SKILL.md'), text);
    return folder;
  }
  async function config(text) {
    await mkdir(join(userHome, '.codex'), { recursive: true });
    await writeFile(join(userHome, '.codex', 'config.toml'), text);
  }
  async function report(extra = {}) {
    const value = await capture.captureCodexSkillSources({ ...options, ...extra });
    assert(schema.validateCodexSkillSourcesReport(value), JSON.stringify(value));
    return value;
  }
  return { base, top, project, userHome, home, options, skill, legacy, config, report };
}
test('manual source capture distinguishes CWD, ancestors and user identities without reading support code or writing review data', async (t) => {
  const f = await fixture(t);
  const folders = await Promise.all([
    f.skill(f.project, 'notes'),
    f.skill(f.top, 'notes'),
    f.skill(f.userHome, 'notes'),
  ]);
  await writeFile(join(folders[0], 'helper.js'), 'fetch(process.env.PRIVATE_KEY_SENTINEL)');
  await f.skill(f.project, '.hidden/secret-notes', 'PRIVATE_HIDDEN_SENTINEL');
  const value = await f.report();
  assert.equal(value.context.boundary, 'marker');
  assert.equal(value.context.ancestorCount, 1);
  assert.equal(value.items.length, 3);
  assert.equal(new Set(value.items.map((i) => i.id)).size, 3);
  assert(
    value.items.every(
      (i) =>
        i.id.startsWith('candidate-') &&
        i.metadata === 'valid' &&
        i.declaredState === 'not-specified' &&
        i.scan.status === 'clean',
    ),
  );
  assert(
    value.items.every(
      (i) => !i.capabilities.some((c) => c.kind === 'cred.env' || c.kind === 'net'),
    ),
  );
  assert.deepEqual(
    value.sources.filter((s) => s.family === 'agents').map((s) => s.scope),
    ['cwd', 'ancestor', 'user'],
  );
  assert.equal(value.sources.filter((s) => s.status === 'uninspected').length, 3);
  assert(value.gaps.some((g) => g.code === 'hidden-sources-skipped'));
  for (const raw of [
    f.base,
    'PRIVATE_KEY_SENTINEL',
    'PRIVATE_HIDDEN_SENTINEL',
    'Summarize release notes',
  ])
    assert.equal(JSON.stringify(value).includes(raw), false);
  await assert.rejects(access(f.home), { code: 'ENOENT' });
});

test('modern and legacy CWD, ancestor and user entrypoints keep distinct path-bound identities', async (t) => {
  const f = await fixture(t);
  for (const root of [f.project, f.top, f.userHome]) {
    await f.skill(root, 'notes');
    await f.legacy(root, 'notes');
  }
  await f.config('[[skills.config]]\nname="notes"\nenabled=false');
  const value = await f.report();
  assert.equal(value.items.length, 6);
  assert.equal(new Set(value.items.map((item) => item.id)).size, 6);
  assert(value.items.every((item) => item.declaredState === 'disabled'));
  assert.deepEqual(
    value.sources
      .filter((source) => source.status !== 'uninspected')
      .map((source) => [source.family, source.scope]),
    [
      ['agents', 'cwd'],
      ['codex-legacy', 'cwd'],
      ['agents', 'ancestor'],
      ['codex-legacy', 'ancestor'],
      ['agents', 'user'],
      ['codex-legacy', 'user'],
    ],
  );
  const expectedModern = `source-${createHash('sha256')
    .update(`stroq-codex-source/1\0${join(f.project, '.agents/skills')}`)
    .digest('hex')
    .slice(0, 24)}`;
  assert.equal(
    value.sources.find((source) => source.family === 'agents' && source.scope === 'cwd').id,
    expectedModern,
  );
  assert.equal(value.sources.filter((source) => source.status === 'uninspected').length, 3);
  assert.equal(
    value.gaps.some((gap) => gap.code === 'compatibility-uninspected'),
    false,
  );
  await assert.rejects(access(f.home), { code: 'ENOENT' });
});

test('selected custom data directory supplies user legacy skills without falling back to the default', async (t) => {
  const f = await fixture(t),
    profile = join(f.userHome, 'custom');
  await f.legacy(f.userHome, 'default-must-not-be-selected');
  await mkdir(join(profile, 'skills/custom-notes'), { recursive: true });
  await writeFile(join(profile, 'skills/custom-notes/SKILL.md'), content('custom-notes'));
  const value = await f.report({ codexEnvironment: { CODEX_HOME: profile } });
  assert.equal(value.context.profile, 'custom');
  assert.equal(value.items.length, 1);
  assert.equal(value.items[0].name, 'custom-notes');
  assert.equal(
    value.sources.find((source) => source.family === 'codex-legacy' && source.scope === 'user')
      .status,
    'complete',
  );
  const unsupported = await f.report({ codexEnvironment: { CODEX_HOME: 'relative' } });
  assert.equal(unsupported.items.length, 0);
  assert.equal(
    unsupported.sources.find(
      (source) => source.family === 'codex-legacy' && source.scope === 'user',
    ).status,
    'uninspected',
  );
  assert(unsupported.gaps.some((gap) => gap.code === 'custom-profile-unsupported'));
  assert.equal(JSON.stringify(unsupported).includes('default-must-not-be-selected'), false);
});

test('long source chains reserve both user roots and explicitly omit the farthest repository roots', async (t) => {
  const f = await fixture(t),
    project = join(f.top, ...Array.from({ length: 31 }, (_, index) => `d${index}`));
  await mkdir(project, { recursive: true });
  await f.skill(f.userHome, 'personal-modern');
  await f.legacy(f.userHome, 'personal-legacy');
  const value = await f.report({ project });
  assert.equal(value.context.ancestorCount, 31);
  assert.equal(value.sources.length, 64);
  assert.equal(value.omitted.sources, 5);
  assert(value.gaps.some((gap) => gap.code === 'source-limit'));
  assert.equal(
    value.sources.filter((source) => source.scope === 'user' && source.status !== 'uninspected')
      .length,
    2,
  );
  assert.deepEqual(value.items.map((item) => item.location.label).sort(), [
    'personal-legacy',
    'personal-modern',
  ]);
  const repo = value.sources.filter((source) => ['cwd', 'ancestor'].includes(source.scope));
  assert.equal(repo[0].family, 'agents');
  assert.equal(repo[1].family, 'codex-legacy');
  assert.equal(repo.at(-1).distance, 29);
  assert.equal(repo.at(-1).family, 'agents');
  assert.equal(value.sources.filter((source) => source.status === 'uninspected').length, 3);
});

test('legacy sources share the global candidate budget and expose omissions', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 70; index++) {
    await f.skill(f.project, `modern-${String(index).padStart(3, '0')}`);
    await f.legacy(f.project, `legacy-${String(index).padStart(3, '0')}`);
  }
  const value = await f.report();
  assert.equal(value.items.length, 128);
  assert.equal(value.omitted.items, 12);
  const legacy = value.sources.find(
    (source) => source.family === 'codex-legacy' && source.scope === 'cwd',
  );
  assert.equal(legacy.status, 'partial');
  assert.equal(legacy.candidates, 58);
  assert(value.gaps.some((gap) => gap.code === 'item-limit' && gap.sourceId === legacy.id));
});

test('project configuration cannot change source boundaries or override the captured user declaration', async (t) => {
  const f = await fixture(t);
  await f.legacy(f.top, 'notes');
  await f.legacy(f.project, 'notes');
  await f.config('[[skills.config]]\nname="notes"\nenabled=true');
  await writeFile(
    join(f.project, '.codex/config.toml'),
    'project_root_markers=[]\n[[skills.config]]\nname="notes"\nenabled=false',
  );
  const value = await f.report();
  assert.equal(value.context.boundary, 'marker');
  assert.equal(value.items.length, 2);
  assert(value.items.every((item) => item.declaredState === 'enabled'));
  await writeFile(join(f.project, '.codex/config.toml'), 'PRIVATE_UNPARSEABLE_PROJECT_SENTINEL=[');
  const unparsed = await f.report();
  assert.equal(unparsed.settings.status, 'ready');
  assert.equal(unparsed.items.length, 2);
  assert(unparsed.items.every((item) => item.declaredState === 'enabled'));
  assert.equal(JSON.stringify(unparsed).includes('PRIVATE_UNPARSEABLE_PROJECT_SENTINEL'), false);
});

test('linked legacy roots and nonregular legacy entrypoints never read their targets', async (t) => {
  const f = await fixture(t),
    outside = join(f.base, 'outside'),
    target = join(outside, 'skills/private-notes');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'SKILL.md'), 'PRIVATE_LINK_TARGET_SENTINEL');
  await symlink(outside, join(f.project, '.codex'));
  const value = await f.report();
  const legacy = value.sources.find(
    (source) => source.family === 'codex-legacy' && source.scope === 'cwd',
  );
  assert.equal(legacy.status, 'partial');
  assert.equal(legacy.candidates, 0);
  assert(
    value.gaps.some((gap) => gap.code === 'source-path-refused' && gap.sourceId === legacy.id),
  );
  assert.equal(JSON.stringify(value).includes('PRIVATE_LINK_TARGET_SENTINEL'), false);
  await rm(join(f.project, '.codex'));
  const folder = await f.legacy(f.project, 'notes');
  await rm(join(folder, 'SKILL.md'));
  await symlink(join(target, 'SKILL.md'), join(folder, 'SKILL.md'));
  const linked = await f.report();
  assert.equal(linked.items.length, 0);
  assert(linked.gaps.some((gap) => gap.code === 'item-path-refused'));
});
test('no repository boundary leaves parent skills outside the manual preview', async (t) => {
  const f = await fixture(t, { repo: false });
  await f.skill(f.top, 'parent-only');
  await f.skill(f.project, 'child-only');
  const value = await f.report();
  assert.equal(value.context.boundary, 'cwd-only');
  assert.equal(value.context.ancestorCount, 0);
  assert.equal(value.items.length, 1);
  assert.equal(value.items[0].location.label, 'child-only');
});
test('valid declared names identify skills independently of folder names, with sensitive names withheld', async (t) => {
  const f = await fixture(t);
  await f.skill(f.project, 'release-folder', content('source-review'));
  await f.skill(f.project, 'safe-folder', content('secrets'));
  const value = await f.report();
  assert.equal(
    value.items.find((i) => i.location.label === 'release-folder').name,
    'source-review',
  );
  assert.equal(value.items.find((i) => i.location.label === 'safe-folder').name, 'safe-folder');
});
test('native human-readable names and directory fallbacks participate in declared configuration matching', async (t) => {
  const f = await fixture(t);
  await f.skill(f.project, 'deploy-folder', content('Deploy Service'));
  await f.skill(
    f.project,
    'fallback-folder',
    '---\ndescription: Useful release notes.\n---\nUseful instructions.',
  );
  await f.config(
    '[[skills.config]]\nname="Deploy Service"\nenabled=false\n[[skills.config]]\nname="fallback-folder"\nenabled=true\n',
  );
  const value = await f.report();
  const deploy = value.items.find((item) => item.location.label === 'deploy-folder');
  assert.equal(deploy.metadata, 'valid');
  assert.equal(deploy.name, 'Deploy Service');
  assert.equal(deploy.declaredState, 'disabled');
  const fallback = value.items.find((item) => item.location.label === 'fallback-folder');
  assert.equal(fallback.metadata, 'valid');
  assert.equal(fallback.name, 'fallback-folder');
  assert.equal(fallback.declaredState, 'enabled');
});
test('strict user configuration describes only captured selectors and invalid metadata stays unknown', async (t) => {
  const f = await fixture(t);
  const local = await f.skill(f.project, 'notes');
  await f.skill(f.top, 'notes');
  await f.skill(
    f.project,
    'invalid',
    '---\nname: [not-a-name]\ndescription: Description\n---\nbody',
  );
  await f.config(
    `[[skills.config]]\nname="notes"\nenabled=false\n[[skills.config]]\npath=${JSON.stringify(join(local, 'SKILL.md'))}\nenabled=true\n`,
  );
  const value = await f.report();
  assert.equal(value.settings.status, 'ready');
  assert.equal(value.settings.rules, 2);
  assert.equal(value.settings.unmatchedRules, 0);
  assert.equal(
    value.items.find(
      (i) =>
        i.sourceId === value.sources.find((s) => s.scope === 'cwd' && s.family === 'agents').id &&
        i.name === 'notes',
    ).declaredState,
    'enabled',
  );
  assert.equal(
    value.items.find((i) => i.sourceId === value.sources.find((s) => s.scope === 'ancestor').id)
      .declaredState,
    'disabled',
  );
  assert.equal(value.items.find((i) => i.name === 'invalid').declaredState, 'unknown');
  await f.config('[[skills.config]]\nname="notes"\nenabled="false"\n');
  const invalid = await f.report();
  assert.equal(invalid.settings.status, 'invalid');
  assert(invalid.items.every((i) => i.declaredState === 'unknown'));
  assert.equal(invalid.context.boundary, 'unverifiable');
  assert.equal(invalid.context.ancestorCount, 0);
});
test('only verified other candidate paths are definite nonmatches; unresolved aliases remain unknown', async (t) => {
  const f = await fixture(t);
  const current = await f.skill(f.project, 'current');
  const ancestor = await f.skill(f.top, 'ancestor');
  await f.skill(f.userHome, 'personal');
  const initial = `[[skills.config]]\nname="notes"\nenabled=true\n[[skills.config]]\npath=${JSON.stringify(join(ancestor, 'SKILL.md'))}\nenabled=false\n`;
  await f.config(initial);
  const known = await f.report();
  assert.equal(known.items.find((i) => i.location.label === 'current').declaredState, 'enabled');
  assert.equal(known.items.find((i) => i.location.label === 'personal').declaredState, 'enabled');
  assert.equal(known.items.find((i) => i.location.label === 'ancestor').declaredState, 'disabled');
  const alias = join(f.base, 'uncaptured-selector');
  await symlink(join(current, 'SKILL.md'), alias);
  await f.config(initial + `[[skills.config]]\npath=${JSON.stringify(alias)}\nenabled=false\n`);
  const unknown = await f.report();
  assert.equal(unknown.items.find((i) => i.location.label === 'current').declaredState, 'unknown');
  assert.equal(unknown.items.find((i) => i.location.label === 'personal').declaredState, 'unknown');
  assert.equal(
    unknown.items.find((i) => i.location.label === 'ancestor').declaredState,
    'disabled',
  );
  assert.equal(unknown.settings.unmatchedRules, 1);
  assert.equal(JSON.stringify(unknown).includes(alias), false);
});
test('linked, hardlinked, oversized and invalid UTF-8 entrypoints cannot receive a clean inspection', async (t) => {
  const f = await fixture(t);
  const ordinary = await f.skill(f.project, 'ordinary');
  await symlink(join(f.top, '.git'), join(ordinary, 'linked-support'));
  const outside = await f.skill(f.userHome, 'outside');
  await symlink(outside, join(f.project, '.agents', 'skills', 'linked-skill'));
  const hard = join(f.project, '.agents', 'skills', 'hard');
  await mkdir(hard);
  await link(join(outside, 'SKILL.md'), join(hard, 'SKILL.md'));
  await f.skill(f.project, 'oversized', 'x'.repeat(65537));
  const invalid = await f.skill(f.project, 'invalid-utf8');
  await writeFile(join(invalid, 'SKILL.md'), Buffer.from([0xff]));
  const value = await f.report();
  assert.equal(
    value.items.some((i) => i.name === 'linked-skill' || i.name === 'hard'),
    false,
  );
  for (const name of ['oversized', 'invalid-utf8']) {
    const item = value.items.find((i) => i.name === name);
    assert.equal(item.scan.status, 'incomplete');
    assert.equal(item.declaredState, 'unknown');
    assert.deepEqual(item.capabilities, []);
  }
  assert(value.gaps.some((g) => g.code === 'item-path-refused'));
  assert(value.gaps.some((g) => g.code === 'bytes-limit'));
});
test('candidate count is global across sources and omissions are explicit', async (t) => {
  const f = await fixture(t);
  for (const root of [f.project, f.userHome])
    for (let i = 0; i < 70; i++) await f.skill(root, `notes-${String(i).padStart(3, '0')}`);
  const value = await f.report();
  assert.equal(value.items.length, 128);
  assert.equal(value.omitted.items, 12);
  assert(value.gaps.some((g) => g.code === 'item-limit'));
  assert(value.sources.some((s) => s.scope === 'user' && s.status === 'partial'));
});
test('a changed captured entrypoint invalidates current inspection state without exposing its replacement', async (t) => {
  const f = await fixture(t);
  const folder = await f.skill(f.project, 'notes');
  const context = await contexts.captureCodexSkillSourceContext(f.options);
  let checks = 0;
  const originalAssert = context.assertCurrent;
  context.assertCurrent = async () => {
    await originalAssert();
    if (++checks === 2) {
      await rename(join(folder, 'SKILL.md'), join(folder, 'old.md'));
      await writeFile(join(folder, 'SKILL.md'), 'PRIVATE_REPLACEMENT_SENTINEL');
    }
  };
  const value = await capture.collectCodexSkillSources(context, {
    runtimeSha256,
    deadline: Date.now() + 15000,
  });
  assert(schema.validateCodexSkillSourcesReport(value));
  assert.equal(value.context.boundary, 'unverifiable');
  assert(value.gaps.some((g) => g.code === 'changed-context'));
  assert(value.items.every((i) => i.scan.status === 'incomplete' && i.declaredState === 'unknown'));
  assert.equal(JSON.stringify(value).includes('PRIVATE_REPLACEMENT_SENTINEL'), false);
});
test('exhausted verification deadline cannot leave complete source rows', async (t) => {
  const f = await fixture(t);
  await f.skill(f.project, 'notes');
  const context = await contexts.captureCodexSkillSourceContext(f.options);
  const value = await capture.collectCodexSkillSources(context, {
    runtimeSha256,
    deadline: Date.now() - 1,
  });
  assert(schema.validateCodexSkillSourcesReport(value));
  assert(value.sources.filter((s) => s.family === 'agents').every((s) => s.status === 'partial'));
  assert(value.gaps.some((g) => g.code === 'deadline'));
});
test('new manual worker operation does not expand ordinary inventory or background observation roots', async (t) => {
  const f = await fixture(t);
  await f.skill(f.top, 'parent-only');
  await f.skill(f.project, 'child-only');
  const context = await contexts.captureCodexSkillSourceContext(f.options);
  async function run(operation) {
    const worker = new Worker(join(output, 'worker.mjs'), {
      workerData: {
        ...f.options,
        operation,
        home: f.home,
        codexExpectedRoots: { project: context.project, user: context.userHome },
      },
      env: {},
      execArgv: [],
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    return new Promise((resolveRun, reject) => {
      worker.once('message', async (value) => {
        await worker.terminate();
        resolveRun(value);
      });
      worker.once('error', reject);
    });
  }
  const manual = await run('codex-sources');
  assert(schema.validateCodexSkillSourcesReport(manual));
  assert.equal(manual.items.length, 2);
  for (const operation of ['read', 'observe']) {
    const ordinary = await run(operation);
    assert.equal(ordinary.items.length, 1);
    assert.equal(ordinary.items[0].name, 'child-only');
  }
  await assert.rejects(access(f.home), { code: 'ENOENT' });
});

test('worker independently refuses stale console-start directory bindings before source capture', async (t) => {
  for (const replaced of ['project', 'userHome']) {
    const f = await fixture(t);
    const original = await contexts.captureCodexSkillSourceContext(f.options);
    const target = f[replaced];
    await rename(target, target + '-original');
    await mkdir(target);
    await f.skill(target, 'replacement-source', content());
    async function run(expected) {
      const worker = new Worker(join(output, 'worker.mjs'), {
        workerData: {
          ...f.options,
          operation: 'codex-sources',
          home: f.home,
          codexExpectedRoots: expected,
        },
        env: {},
        execArgv: [],
        stdout: true,
        stderr: true,
      });
      worker.stdout.resume();
      worker.stderr.resume();
      return new Promise((resolveRun, reject) => {
        worker.once('message', async (value) => {
          await worker.terminate();
          resolveRun(value);
        });
        worker.once('error', reject);
      });
    }
    const refused = await run({ project: original.project, user: original.userHome });
    assert.deepEqual(refused, { error: 'inventory-unavailable' });
    const current = await contexts.captureCodexSkillSourceContext(f.options);
    const accepted = await run({ project: current.project, user: current.userHome });
    assert(schema.validateCodexSkillSourcesReport(accepted));
    assert.equal(accepted.items.length, 1);
    assert.equal(accepted.items[0].location.label, 'replacement-source');
    await assert.rejects(access(f.home), { code: 'ENOENT' });
  }
});
