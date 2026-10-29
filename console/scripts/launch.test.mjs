import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLaunchOptions, launch } from './launch.mjs';
test('launcher uses an explicit local workspace and accepts no commands or network hosts', () => {
  assert.deepEqual(
    parseLaunchOptions(['--workspace', '/local/project', '--port', '47820'], '/cwd'),
    { workspace: '/local/project', port: 47820, help: false },
  );
  assert.deepEqual(parseLaunchOptions([], '/cwd'), { workspace: '/cwd', port: 47815, help: false });
  for (const args of [
    ['--port', 'abc'],
    ['--port', '65536'],
    ['--host', '0.0.0.0'],
    ['--command', 'sh'],
    ['extra'],
  ])
    assert.throws(() => parseLaunchOptions(args, '/cwd'));
});
test('help never starts a server and normal launch passes the selected scope', async () => {
  let invoked = false;
  const output = [];
  await launch(['--help'], {
    cwd: '/cwd',
    out: (line) => output.push(line),
    start: async () => {
      invoked = true;
    },
  });
  assert.equal(invoked, false);
  assert.match(output.join(''), /workspace/);
  const result = await launch(['--workspace', '/project', '--port', '0'], {
    cwd: '/cwd',
    out: (line) => output.push(line),
    start: async (options) => {
      assert.deepEqual(options, { project: '/project', port: 0 });
      return { url: 'http://127.0.0.1:1/#token=private-fixture' };
    },
  });
  assert.equal(result.url, 'http://127.0.0.1:1/#token=private-fixture');
});
