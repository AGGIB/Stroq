import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { completePlan, readSetupInputs } from './agent-setup-plan.mjs';
import { rootIdentity } from './agent-setup-files.mjs';
import { inspectConfiguration, validConfiguration } from './agent-status-config.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await mkdtemp(join(tmpdir(), 'stroq-setup-transform-'));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: { adapter: resolve(repository, 'console/scripts/agent-status-engine.ts') },
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
    js: "import { createRequire as createSetupRequire } from 'node:module'; const require = createSetupRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.alias = { '@stroq/core': resolve(repository, 'packages/core/src/index.ts') };
  },
});
for (const name of ['atlas', 'scope', 'asi'])
  await copyFile(
    resolve(repository, `packages/cli/src/coverage/${name}.json`),
    join(output, `${name}.json`),
  );
const adapter = await import(pathToFileURL(join(output, 'adapter.mjs')).href);
const command = (agent) => `"${process.execPath}" "/fixed/stroq.js" hook ${agent}`;
const agents = ['claude-code', 'cursor', 'codex'];
const direct = (agent) => agent === 'cursor';
function fixture(agent) {
  const expected = adapter.expectedConfiguration(agent, command(agent));
  const config = structuredClone(expected);
  const event = Object.keys(config.hooks)[0];
  const foreign = { command: 'PRIVATE_OTHER', type: 'command' };
  const lookalike = { ...foreign, command: `"/foreign/tool" hook ${agent}` };
  if (direct(agent)) config.hooks[event].push(foreign, lookalike);
  else config.hooks[event][0].hooks.push(foreign, lookalike);
  config.PRIVATE_SETTINGS = { nested: [1, 'sentinel'] };
  return { expected, config, event, foreign, lookalike };
}

test('missing and empty files create only current templates; intact files retain every raw byte', () => {
  for (const agent of agents) {
    const expected = adapter.expectedConfiguration(agent, command(agent));
    for (const empty of [null, '', ' \r\n']) {
      const result = adapter.prepareAgentSetup(empty, agent, command(agent));
      assert.deepEqual(JSON.parse(result.candidateText), expected);
      assert.equal(result.addedHooks, result.hookEvents.length);
      assert.equal(result.replacedHooks, 0);
    }
    const raw = '\uFEFF' + JSON.stringify(expected, null, '\t').replace(/\n/g, '\r\n') + '\r\n';
    const intact = adapter.prepareAgentSetup(raw, agent, command(agent));
    assert.equal(intact.candidateText, raw);
    assert.equal(intact.addedHooks, 0);
    assert.equal(intact.replacedHooks, 0);
  }
});

test('windsurf has no current template and setup refuses it as an unsupported agent', () => {
  assert.throws(() => adapter.expectedConfiguration('windsurf', command('windsurf')), {
    message: 'unsupported-agent',
  });
  for (const empty of [null, '{}', '{"hooks":{"pre_run_command":[]}}'])
    assert.throws(() => adapter.prepareAgentSetup(empty, 'windsurf', command('windsurf')), {
      message: 'unsupported-agent',
    });
});

test('unmatched handlers, suffix lookalikes and unknown settings survive repeated Connect unchanged', () => {
  for (const agent of agents) {
    const { config } = fixture(agent),
      before = structuredClone(config);
    const raw = JSON.stringify(config);
    const result = adapter.prepareAgentSetup(raw, agent, command(agent));
    assert.equal(result.candidateText, raw);
    assert.equal(result.preservedHooks, 2);
    assert.equal(result.remainingLookalikes, 1);
    assert.equal(result.addedHooks, 0);
    assert.equal(result.replacedHooks, 0);
    assert.deepEqual(config, before);
    assert.equal(
      adapter.prepareAgentSetup(result.candidateText, agent, command(agent)).candidateText,
      raw,
    );
  }
});

test('altered options and group metadata remain intact while missing exact handlers are appended', () => {
  for (const agent of agents) {
    const { config, event } = fixture(agent);
    if (direct(agent)) config.hooks[event][0].PRIVATE_OPTION = true;
    else config.hooks[event][0].PRIVATE_GROUP_METADATA = 'preserve';
    config.hooks.FutureEvent = direct(agent)
      ? [{ command: command(agent), unknown: true }]
      : [{ matcher: 'PRIVATE', hooks: [{ command: command(agent), unknown: true }] }];
    const originalEntries = structuredClone(config.hooks[event]);
    const result = adapter.prepareAgentSetup(JSON.stringify(config), agent, command(agent));
    const after = JSON.parse(result.candidateText);
    assert.deepEqual(after.hooks[event].slice(0, originalEntries.length), originalEntries);
    assert.deepEqual(after.hooks.FutureEvent, config.hooks.FutureEvent);
    assert.equal(result.addedHooks, 1);
    assert.equal(result.replacedHooks, 0);
    assert.equal(result.remainingLookalikes, 3);
  }
});

test('only exact duplicates are deduplicated, keeping the first valid registration in place', () => {
  for (const agent of agents) {
    const { config, event } = fixture(agent);
    if (direct(agent)) config.hooks[event].push(structuredClone(config.hooks[event][0]));
    else config.hooks[event][0].hooks.push(structuredClone(config.hooks[event][0].hooks[0]));
    const result = adapter.prepareAgentSetup(JSON.stringify(config), agent, command(agent));
    const after = JSON.parse(result.candidateText);
    assert.deepEqual(
      after.hooks[event][0],
      config.hooks[event][0].hooks
        ? {
            ...config.hooks[event][0],
            hooks: config.hooks[event][0].hooks.slice(0, -1),
          }
        : config.hooks[event][0],
    );
    assert.equal(result.replacedHooks, 1);
    assert.equal(result.addedHooks, 0);
    assert.equal(result.preservedHooks, 2);
    assert.equal(result.remainingLookalikes, 1);
  }
});

test('Codex root arrays and bare groups remain in place and are recognized by read-only status', () => {
  const expected = adapter.expectedConfiguration('codex', command('codex'));
  const config = {
    PreToolUse: expected.hooks.PreToolUse,
    PostToolUse: expected.hooks.PostToolUse[0],
    PRIVATE_META: true,
  };
  const raw = JSON.stringify(config, null, 4) + '\n';
  const result = adapter.prepareAgentSetup(raw, 'codex', command('codex'));
  assert.equal(result.candidateText, raw);
  assert.equal(result.addedHooks, 0);
  assert.equal(validConfiguration(config, 'codex'), true);
  assert.equal(inspectConfiguration(config, expected, 'codex').state, 'present');
  const mixed = {
    PreToolUse: expected.hooks.PreToolUse[0],
    hooks: { PreToolUse: expected.hooks.PreToolUse },
    PostToolUse: expected.hooks.PostToolUse,
  };
  const deduped = JSON.parse(
    adapter.prepareAgentSetup(JSON.stringify(mixed), 'codex', command('codex')).candidateText,
  );
  assert.deepEqual(deduped.PreToolUse, mixed.PreToolUse);
  assert.equal(deduped.hooks, undefined);
  assert.deepEqual(deduped.PostToolUse, mixed.PostToolUse);
});

test('unknown-event lookalikes keep read-only status in review instead of a clean present state', () => {
  for (const agent of agents) {
    const expected = adapter.expectedConfiguration(agent, command(agent));
    const config = structuredClone(expected);
    config.hooks.FutureEvent = direct(agent)
      ? [{ command: command(agent) }]
      : [{ matcher: '*', hooks: [{ command: command(agent) }] }];
    assert.equal(inspectConfiguration(config, expected, agent).state, 'changed');
  }
});

test('strict parser and shape checks refuse duplicate/lossy/JSONC/invalid UTF8/disabled/oversized sources', () => {
  for (const text of [
    '{"x":1,"x":2}',
    '{"x":9007199254740993}',
    '{/*jsonc*/}',
    '{"hooks":[]}',
    '{"hooks":{"PreToolUse":[null]}}',
    '{"disableAllHooks":true}',
    '{"hooksDisabled":true}',
    ' '.repeat(1024 * 1024 + 1),
  ]) {
    assert.throws(
      () => adapter.prepareAgentSetup(text, 'claude-code', command('claude-code')),
      /invalid-config|hooks-disabled|config-too-large/,
    );
  }
  assert.throws(() => adapter.parseSetupObject(Buffer.from([0xff])), /invalid-config/);
  assert.throws(() => adapter.parseSetupObject('{"version":1,"version":1}'), /invalid-config/);
});

function planFixture(agent, custom) {
  const source = fixture(agent),
    config = custom ?? source.config,
    expected = source.expected,
    text = JSON.stringify(config),
    root = { path: '/fixture', dev: 1, ino: 2 };
  const input = {
    config,
    root,
    file: '/fixture/config.json',
    before: { bytes: Buffer.from(text), sha256: 'a'.repeat(64), mode: 0o600 },
    recordFile: '/fixture/.stroq/install.json',
    recordBefore: { bytes: null, sha256: 'absent', mode: 0o600 },
    record: {},
  };
  const options = {
    userRoot: root,
    paths: { cli: '/fixed/stroq.js' },
    expected,
    parseSetupObject: adapter.parseSetupObject,
  };
  return { input, options, prepared: adapter.prepareAgentSetup(text, agent, command(agent)) };
}
test('completePlan independently rejects missing foreign content and forged metadata', () => {
  const { input, options, prepared } = planFixture('claude-code');
  const valid = completePlan(input, prepared, 'claude-code', 'project', options, 'fixture', 0);
  assert.equal(valid.record.next, null);
  assert.equal(valid.preservedHooks, 2);
  assert.equal(valid.remainingLookalikes, 1);
  const dropped = JSON.parse(prepared.candidateText);
  dropped.hooks.PreToolUse[0].hooks.pop();
  assert.throws(
    () =>
      completePlan(
        input,
        { ...prepared, candidateText: JSON.stringify(dropped) },
        'claude-code',
        'project',
        options,
        'fixture',
        0,
      ),
    /merge-not-preserving|invalid-engine-preview/,
  );
  for (const key of ['preservedHooks', 'replacedHooks', 'addedHooks', 'remainingLookalikes']) {
    assert.throws(
      () =>
        completePlan(
          input,
          { ...prepared, [key]: prepared[key] + 1 },
          'claude-code',
          'project',
          options,
          'fixture',
          0,
        ),
      /invalid-engine-preview/,
    );
  }
});

test('independent plan accepts preserved empty containers, altered metadata and legacy root shapes', () => {
  for (const agent of agents) {
    const expected = adapter.expectedConfiguration(agent, command(agent));
    const first = Object.keys(expected.hooks)[0];
    const configurations = [
      {},
      { hooks: {} },
      { hooks: { [first]: [], FutureEvent: [] } },
      { hooks: { FutureEvent: direct(agent) ? [] : [{ matcher: 'EMPTY_PRIVATE', hooks: [] }] } },
    ];
    if (agent === 'codex')
      configurations.push(
        {
          PreToolUse: expected.hooks.PreToolUse[0],
          hooks: { PreToolUse: expected.hooks.PreToolUse },
          PostToolUse: expected.hooks.PostToolUse,
        },
        { PreToolUse: [], PostToolUse: { matcher: '*', hooks: [] } },
      );
    const changed = structuredClone(expected);
    if (direct(agent)) changed.hooks[first][0].PRIVATE = true;
    else changed.hooks[first][0].PRIVATE = true;
    configurations.push(changed);
    for (const config of configurations) {
      const { input, options, prepared } = planFixture(agent, config);
      assert.doesNotThrow(() =>
        completePlan(input, prepared, agent, 'project', options, 'fixture', 0),
      );
    }
  }
});

test('independent plan refuses foreign empty-container deletion, metadata edits and raw-only rewrites', () => {
  const config = fixture('claude-code').config;
  config.hooks.EmptyEvent = [];
  config.hooks.EmptyGroup = [{ private: true, hooks: [] }];
  const { input, options, prepared } = planFixture('claude-code', config);
  for (const edit of [
    (next) => {
      delete next.PRIVATE_SETTINGS;
    },
    (next) => {
      delete next.hooks.EmptyEvent;
    },
    (next) => {
      delete next.hooks.EmptyGroup;
    },
    (next) => {
      next.hooks.PreToolUse[0].matcher = 'PRIVATE_OTHER';
    },
    (next) => {
      next.hooks.PreToolUse[0].hooks.reverse();
    },
  ]) {
    const next = JSON.parse(prepared.candidateText);
    edit(next);
    assert.throws(
      () =>
        completePlan(
          input,
          { ...prepared, candidateText: JSON.stringify(next) },
          'claude-code',
          'project',
          options,
          'fixture',
          0,
        ),
      /merge-not-preserving|invalid-engine-preview/,
    );
  }
  assert.throws(
    () =>
      completePlan(
        input,
        { ...prepared, candidateText: JSON.stringify(config, null, 2) },
        'claude-code',
        'project',
        options,
        'fixture',
        0,
      ),
    /invalid-engine-preview/,
  );
});

test('lookalikes with multiple arguments or extra whitespace are preserved and require review', () => {
  for (const agent of agents) {
    const expected = adapter.expectedConfiguration(agent, command(agent));
    const config = structuredClone(expected);
    const commands = [`echo hook ${agent} --one --two`, `echo hook\t${agent}  `];
    config.hooks.FutureEvent = direct(agent)
      ? commands.map((command) => ({ command }))
      : [{ hooks: commands.map((command) => ({ command })) }];
    const { input, options, prepared } = planFixture(agent, config);
    assert.equal(prepared.remainingLookalikes, 2);
    assert.equal(prepared.preservedHooks, 2);
    assert.equal(inspectConfiguration(config, expected, agent).state, 'changed');
    assert.doesNotThrow(() =>
      completePlan(input, prepared, agent, 'project', options, 'fixture', 0),
    );
  }
});

test('setup input capture uses the hardened parser for config and advisory record', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'stroq-setup-input-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project'),
    user = join(directory, 'user');
  await mkdir(join(project, '.claude'), { recursive: true });
  await mkdir(join(user, '.stroq'), { recursive: true });
  const roots = { projectRoot: await rootIdentity(project), userRoot: await rootIdentity(user) };
  const configFile = join(project, '.claude/settings.json');
  const recordFile = join(user, '.stroq/install.json');
  const capture = (agent) => readSetupInputs(agent, 'project', roots, adapter.parseSetupObject);
  const config = '{"PRIVATE":1,"PRIVATE":2}';
  await writeFile(configFile, config);
  await assert.rejects(capture('claude-code'), /invalid-config/);
  assert.equal(await readFile(configFile, 'utf8'), config);
  await writeFile(configFile, '{}');
  const record = '{"version":1,"version":1,"entries":{}}';
  await writeFile(recordFile, record);
  await assert.rejects(capture('claude-code'), /invalid-install-record/);
  assert.equal(await readFile(recordFile, 'utf8'), record);
});

test('advisory installation records never authorize handler removal or writes on a raw no-op', () => {
  for (const agent of agents) {
    const { input, options, prepared } = planFixture(agent);
    const recordBytes = Buffer.from('{"version":1,"entries":{}}');
    input.recordBefore.bytes = recordBytes;
    input.record = {
      version: 1,
      entries: { [`${agent}:project`]: { command: 'UNRELATED_RECORDER', recordedAt: 'PRIVATE' } },
    };
    const plan = completePlan(input, prepared, agent, 'project', options, 'fixture', 0);
    assert.equal(plan.record.next, recordBytes);
    assert.equal(plan.preservedHooks, 2);
  }
  const { input, options, prepared } = planFixture('cursor', {});
  input.record.PRIVATE = 'x'.repeat(1024 * 1024);
  assert.throws(
    () => completePlan(input, prepared, 'cursor', 'project', options, 'fixture', 0),
    /config-too-large/,
  );
});
