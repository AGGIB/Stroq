import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await mkdtemp(join(tmpdir(), 'stroq-disconnect-transform-'));
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
    js: "import { createRequire as createDisconnectRequire } from 'node:module'; const require = createDisconnectRequire(import.meta.url);",
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
const command = '"/fixed/node" "/fixed/stroq.js" hook ';

test('all three exact current templates can be removed without touching unrelated config', () => {
  for (const agent of ['claude-code', 'cursor', 'codex']) {
    const config = {
      ...adapter.expectedConfiguration(agent, command + agent),
      env: { PRIVATE_TOKEN: 'sentinel' },
      unknown: [1, 2],
    };
    const original = structuredClone(config);
    const result = adapter.prepareAgentDisconnect(JSON.stringify(config), agent, command + agent);
    assert.ok(result.removedHooks > 0);
    assert.deepEqual(JSON.parse(result.candidateText), {
      ...(agent === 'cursor' ? { version: 1 } : {}),
      env: config.env,
      unknown: [1, 2],
    });
    assert.equal(result.remainingLookalikes, 0);
    assert.equal(result.preservedHooks, 0);
    assert.deepEqual(config, original);
  }
});

test('windsurf is no longer a disconnect target and is refused as an unsupported agent', () => {
  const text = JSON.stringify({ hooks: { pre_run_command: [{ command: command + 'windsurf' }] } });
  assert.throws(() => adapter.expectedConfiguration('windsurf', command + 'windsurf'), {
    message: 'unsupported-agent',
  });
  assert.throws(() => adapter.prepareAgentDisconnect(text, 'windsurf', command + 'windsurf'), {
    message: 'unsupported-agent',
  });
  assert.throws(() => adapter.prepareAgentDisconnect(null, 'windsurf', command + 'windsurf'), {
    message: 'unsupported-agent',
  });
});

test('same command with changed handler or group metadata stays untouched, as do lookalikes', () => {
  const agent = 'claude-code';
  const config = adapter.expectedConfiguration(agent, command + agent);
  const group = config.hooks.PreToolUse[0];
  const handler = group.hooks[0];
  group.hooks.push({ ...handler, timeout: 999 }, { type: 'command', command: 'PRIVATE_OTHER' });
  config.hooks.PreToolUse.push({ ...group, matcher: 'PRIVATE_MATCHER', hooks: [handler] });
  config.hooks.FutureEvent = [{ matcher: group.matcher, hooks: [handler] }];
  const result = adapter.prepareAgentDisconnect(JSON.stringify(config), agent, command + agent);
  const remaining = JSON.parse(result.candidateText);
  assert.deepEqual(remaining.hooks.PreToolUse[0].hooks, [
    { ...handler, timeout: 999 },
    { type: 'command', command: 'PRIVATE_OTHER' },
  ]);
  assert.deepEqual(remaining.hooks.PreToolUse[1], config.hooks.PreToolUse[1]);
  assert.deepEqual(remaining.hooks.FutureEvent, config.hooks.FutureEvent);
  assert.equal(result.remainingLookalikes, 3);
  assert.equal(result.preservedHooks, 4);
  const direct = adapter.expectedConfiguration('cursor', command + 'cursor');
  direct.hooks.preToolUse[0].matcher = 'PRIVATE_CHANGED';
  direct.hooks.preToolUse.push({
    command: '"/foreign" hook cursor',
    failClosed: true,
    timeout: 15,
  });
  const cursor = adapter.prepareAgentDisconnect(
    JSON.stringify(direct),
    'cursor',
    command + 'cursor',
  );
  assert.deepEqual(JSON.parse(cursor.candidateText).hooks.preToolUse, direct.hooks.preToolUse);
  assert.equal(cursor.remainingLookalikes, 2);
});

test('Codex root groups and arrays retain their original shapes and foreign metadata', () => {
  const expected = adapter.expectedConfiguration('codex', command + 'codex');
  const group = expected.hooks.PreToolUse[0];
  const foreign = { type: 'command', command: 'PRIVATE_FOREIGN', timeout: 17 };
  const config = {
    PreToolUse: { ...group, hooks: [...group.hooks, foreign] },
    PostToolUse: expected.hooks.PostToolUse,
    SessionStart: { matcher: '*', hooks: [foreign] },
    hooks: { PreToolUse: expected.hooks.PreToolUse },
    keep: { hooks: 'not-an-event' },
  };
  const result = adapter.prepareAgentDisconnect(JSON.stringify(config), 'codex', command + 'codex');
  assert.deepEqual(JSON.parse(result.candidateText), {
    PreToolUse: { ...group, hooks: [foreign] },
    SessionStart: config.SessionStart,
    keep: config.keep,
  });
  assert.equal(result.removedHooks, 3);
});

test('strict parsing rejects duplicate decoded keys, lossy numbers, JSONC and oversized input', () => {
  for (const text of [
    '{"x":1,"x":2}',
    '{"x":1,"\\u0078":2}',
    '{"x":9007199254740993}',
    '{"x":-0}',
    '{/* comment */}',
    '{"x":1,}',
    '[]',
    'null',
    '"value"',
    ' '.repeat(1024 * 1024 + 1),
  ]) {
    assert.throws(
      () => adapter.prepareAgentDisconnect(text, 'cursor', command + 'cursor'),
      /invalid-config|config-too-large/,
    );
  }
});

test('layout keeps BOM, CRLF and indentation; no-op preserves every original byte', () => {
  const config = adapter.expectedConfiguration('cursor', command + 'cursor');
  config.disableAllHooks = true;
  const text = '\uFEFF' + JSON.stringify(config, null, '\t').replace(/\n/g, '\r\n') + '\r\n';
  const result = adapter.prepareAgentDisconnect(text, 'cursor', command + 'cursor');
  assert.equal(
    result.candidateText,
    '\uFEFF{\r\n\t"version": 1,\r\n\t"disableAllHooks": true\r\n}\r\n',
  );
  const foreign = '{  "hooks": {"future": []}, "untouched": 1 }';
  assert.equal(
    adapter.prepareAgentDisconnect(foreign, 'cursor', command + 'cursor').candidateText,
    foreign,
  );
  assert.equal(
    adapter.prepareAgentDisconnect(null, 'cursor', command + 'cursor').candidateText,
    null,
  );
});
