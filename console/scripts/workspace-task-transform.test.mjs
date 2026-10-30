import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await mkdtemp(join(tmpdir(), 'stroq-workspace-task-transform-'));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: { transform: resolve(repository, 'console/scripts/workspace-task-transform.ts') },
  outDir: output,
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  splitting: false,
  config: false,
  dts: false,
  silent: true,
});
const { planWorkspaceTasks, WORKSPACE_TASK_MAX_BYTES, WORKSPACE_TASK_MAX_TASKS } = await import(
  pathToFileURL(join(output, 'transform.mjs')).href
);
const encode = (text) => Buffer.from(text, 'utf8');
const task = (runOn) => ({ label: 'same label', command: 'never execute', runOptions: { runOn } });
const document = (tasks) => JSON.stringify({ version: '2.0.0', tasks });
const refuse = (value, code = 'unsupported-task-config') =>
  assert.throws(
    () => planWorkspaceTasks(typeof value === 'string' ? encode(value) : value),
    (error) => error.message === code,
  );

test('eight mixed automatic triggers change only their string tokens; manual tasks and commands stay byte-identical', () => {
  const automatic = [
    'folderOpen',
    'worktreeCreated',
    'FOLDEROPEN',
    'WORKTREECREATED',
    'folderOpen',
    'worktreeCreated',
    'FolderOpen',
    'WorktreeCreated',
  ];
  const lines = [
    '{ // keep this comment and every unknown field',
    ' "version": "2.0.0", "unknown": {"future": [1,2,3]},',
    ' "tasks": [',
    ...automatic.map(
      (value, index) =>
        `  {"label":"same label","command":"echo folderOpen worktreeCreated", "args":["runOn"], "dependsOn":"manual", "osx":{"command":"echo mac"}, "windows":{"command":"echo win"}, "linux":{"command":"echo linux"}, "runOptions": { "runOn": ${JSON.stringify(value)}, "reevaluateOnRerun":false, "future":${index} }}, // task ${index}`,
    ),
    '  {"label":"manual","type":"shell","command":"echo manual","runOptions":{"runOn":"default"}},',
    '  {"label":"same label","command":"echo other manual","metadata":{"runOn":"folderOpen"}},',
    ' ],',
    ' "inputs": [{"id":"x","type":"command","command":"do-not-invoke"}],',
    '}',
  ];
  const input = encode(lines.join('\n') + '\n'),
    before = Buffer.from(input);
  const expected =
    lines
      .map((line, index) =>
        index >= 3 && index < 11 ? line.replace(/("runOn": )"[^"]+"/, '$1"default"') : line,
      )
      .join('\n') + '\n';
  const result = planWorkspaceTasks(input);
  assert(Buffer.isBuffer(result.bytes));
  assert.deepEqual(result.changes, { folderOpen: 4, worktreeCreated: 4 });
  assert.deepEqual(result.bytes, encode(expected));
  assert.deepEqual(input, before);
});

test('BOM, CRLF, non-ASCII text, escaped keys/values and JSONC remain exact outside the replaced values', () => {
  const text =
    '\uFEFF{\r\n // \u041f\u0440\u0438\u0432\u0435\u0442 \u4e16\u754c\r\n "version":"2.0.0", "ta\\u0073ks": [\r\n {"label":"\u4e16\u754c","run\\u004fptions":{"run\\u004fn": /* keep */ "\\u0066olderOpen",}},\r\n {"label":"x","runOptions":{"runOn":"worktree\\u0043reated",}},\r\n ],\r\n}\r\n';
  const expected = text
    .replace('"\\u0066olderOpen"', '"default"')
    .replace('"worktree\\u0043reated"', '"default"');
  const result = planWorkspaceTasks(encode(text));
  assert.deepEqual(result.bytes, encode(expected));
  assert.deepEqual(result.changes, { folderOpen: 1, worktreeCreated: 1 });
});

test('comments ending at each VS Code line break retain their original bytes', () => {
  for (const eol of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    const text = `{"version":"2.0.0"// keep${eol},"tasks":[{"runOptions":{"runOn":/*x*/"folderOpen"}}]}`;
    assert.equal(
      planWorkspaceTasks(encode(text)).bytes.toString('utf8'),
      text.replace('/*x*/"folderOpen"', '/*x*/"default"'),
    );
  }
});

test('runOn-looking comments, command strings and unrelated nested metadata cannot become edit targets', () => {
  const text =
    '{"version":"2.0.0",/*"runOn":"folderOpen"*/"tasks":[{"command":"\\\"runOn\\\":\\\"worktreeCreated\\\"","runOptions":{"runOn":"folderOpen","metadata":{"runOn":"folderOpen"}},"metadata":{"tasks":[{"runOptions":{"runOn":"worktreeCreated"}}]}}],"metadata":{"runOptions":{"runOn":"folderOpen"}}}';
  const expected = text.replace(
    '"runOptions":{"runOn":"folderOpen","metadata"',
    '"runOptions":{"runOn":"default","metadata"',
  );
  assert.equal(planWorkspaceTasks(encode(text)).bytes.toString('utf8'), expected);
});

test('strict decoded duplicate keys, forbidden keys, excessive depth, syntax and invalid UTF-8 refuse without mutation', () => {
  for (const text of [
    '{"version":"2.0.0","tasks":[],"tasks":[]}',
    '{"version":"2.0.0","tasks":[],"ta\\u0073ks":[]}',
    '{"version":"2.0.0","tasks":[{"runOptions":{"runOn":"folderOpen","run\\u004fn":"default"}}]}',
    ...['__proto__', 'constructor', 'prototype'].map(
      (key) =>
        `{"version":"2.0.0","tasks":[{"runOptions":{"runOn":"folderOpen"},"metadata":{"${key}":1}}]}`,
    ),
    '{"version":"2.0.0","tasks":[{"runOptions":{"runOn":"folderOpen"}}],"deep":' +
      '['.repeat(33) +
      '0' +
      ']'.repeat(33) +
      '}',
    '{"version":"2.0.0","tasks":[}',
    '/* never closed',
  ]) {
    const bytes = encode(text),
      before = Buffer.from(bytes);
    refuse(bytes);
    assert.deepEqual(bytes, before);
  }
  refuse(Buffer.from([0xff, 0xfe]));
  refuse(Buffer.from([0xc3, 0x28]));
  refuse('null');
  refuse('[]');
});

test('unsupported versions, malformed run options, unknown triggers and ambiguous OS/global trigger placement refuse', () => {
  const automatic = task('folderOpen');
  for (const value of [
    {},
    { tasks: [automatic] },
    { version: '0.1.0', tasks: [automatic] },
    { version: 2, tasks: [automatic] },
    { version: '2.0.0', tasks: {} },
    { version: '2.0.0', tasks: [null] },
    { version: '2.0.0', tasks: [[]] },
    ...[null, [], false, 'folderOpen', 3].map((runOptions) => ({
      version: '2.0.0',
      tasks: [{ runOptions }],
    })),
    ...[null, false, 3, [], {}, '', 'onSave', ' folderOpen'].map((runOn) => ({
      version: '2.0.0',
      tasks: [task(runOn)],
    })),
    { version: '2.0.0', tasks: [automatic], runOptions: { runOn: 'folderOpen' } },
    ...['windows', 'linux', 'osx'].flatMap((os) => [
      { version: '2.0.0', tasks: [automatic], [os]: { tasks: [] } },
      { version: '2.0.0', tasks: [automatic], [os]: { runOptions: { runOn: 'folderOpen' } } },
      { version: '2.0.0', tasks: [{ ...automatic, [os]: { runOptions: { runOn: 'default' } } }] },
      { version: '2.0.0', tasks: [automatic], [os]: null },
    ]),
  ])
    refuse(JSON.stringify(value));
});

test('valid zero-trigger files report no-automatic-tasks, including already-transformed bytes', () => {
  for (const tasks of [
    [],
    [{}],
    [{ runOptions: {} }],
    [task('default')],
    [task('DEFAULT')],
    [{ metadata: { runOn: 'folderOpen' } }],
  ])
    refuse(document(tasks), 'no-automatic-tasks');
  const result = planWorkspaceTasks(
    encode(document([task('folderOpen'), task('worktreeCreated')])),
  );
  refuse(result.bytes, 'no-automatic-tasks');
});

test('the byte and task caps are exact, never silently truncate automatic triggers', () => {
  assert.equal(WORKSPACE_TASK_MAX_BYTES, 256 * 1024);
  assert.equal(WORKSPACE_TASK_MAX_TASKS, 256);
  const base = JSON.stringify({ version: '2.0.0', tasks: [task('folderOpen')], padding: '' });
  const atLimit = base.replace(
    '"padding":""',
    '"padding":"' + ' '.repeat(WORKSPACE_TASK_MAX_BYTES - Buffer.byteLength(base)) + '"',
  );
  assert.equal(Buffer.byteLength(atLimit), WORKSPACE_TASK_MAX_BYTES);
  assert.equal(planWorkspaceTasks(encode(atLimit)).changes.folderOpen, 1);
  refuse(atLimit + ' ');
  const tasks = Array.from({ length: WORKSPACE_TASK_MAX_TASKS }, (_, i) =>
    task(i % 2 ? 'worktreeCreated' : 'folderOpen'),
  );
  assert.deepEqual(planWorkspaceTasks(encode(document(tasks))).changes, {
    folderOpen: 128,
    worktreeCreated: 128,
  });
  refuse(document([...tasks, {}]));
  refuse(document(Array.from({ length: 257 }, () => ({}))));
});

test('planning returns bytes only and never executes a discovered task command', async () => {
  const sentinel = join(output, 'must-not-exist');
  const bytes = encode(
    document([
      {
        ...task('worktreeCreated'),
        type: 'process',
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'unexpected')`],
      },
    ]),
  );
  const result = planWorkspaceTasks(bytes);
  assert.deepEqual(Object.keys(result).sort(), ['bytes', 'changes']);
  await assert.rejects(access(sentinel), { code: 'ENOENT' });
});
