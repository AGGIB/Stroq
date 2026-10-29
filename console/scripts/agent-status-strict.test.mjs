import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createAgentStatus } from './agent-status.mjs';

const adapter = await import('../.local-engine/agent-status-engine.js');
const AGENTS = ['claude-code', 'cursor', 'codex'];
function relativeTarget(agent) {
  if (agent === 'claude-code') return '.claude/settings.json';
  return `.${agent}/hooks.json`;
}
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'stroq-agent-status-strict-')));
  const project = join(directory, 'project');
  const userHome = join(directory, 'user');
  await Promise.all([mkdir(project), mkdir(userHome)]);
  const cli = join(directory, 'engine.js');
  const packageFile = join(directory, 'package.json');
  await Promise.all([
    writeFile(cli, '/* inert runtime: status never starts this */'),
    writeFile(packageFile, '{"version":"0.28.0"}'),
  ]);
  const service = await createAgentStatus({
    project,
    userHome,
    home: join(userHome, '.stroq'),
    paths: { cli, package: packageFile },
  });
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  const expected = (agent) =>
    adapter.expectedConfiguration(agent, `"${process.execPath}" "${cli}" hook ${agent}`);
  const file = (agent, scope) =>
    join(scope === 'project' ? project : userHome, relativeTarget(agent));
  async function write(agent, scope, bytes) {
    await mkdir(dirname(file(agent, scope)), { recursive: true });
    await writeFile(file(agent, scope), bytes);
  }
  async function read(agent, scope) {
    const response = await service.read();
    assert.equal(response.status, 200, JSON.stringify(response));
    assert.ok(!JSON.stringify(response).includes(directory));
    assert.ok(!JSON.stringify(response).includes('PRIVATE_PARSE_FIELD'));
    const row = response.body.agents.find((row) => row.id === agent);
    assert.notEqual(row.proof.state, 'verified');
    return row.scopes.find((row) => row.scope === scope);
  }
  return { directory, project, userHome, expected, file, write, read };
}

test('actual status refuses duplicate or lossy configuration instead of establishing current coverage', async (t) => {
  const f = await fixture(t);
  for (const agent of AGENTS)
    for (const scope of ['project', 'user']) {
      const body = JSON.stringify(f.expected(agent));
      const invalid = [
        `{"hooks":{},${body.slice(1)}`,
        `{"disableAllHooks":true,"disableAllHooks":false,${body.slice(1)}`,
        `{"PRIVATE_PARSE_FIELD":9007199254740993,${body.slice(1)}`,
        '\uFEFF\uFEFF' + body,
        Buffer.concat([Buffer.from(body), Buffer.from([0xff])]),
      ];
      for (const source of invalid) {
        const before = Buffer.from(source);
        await f.write(agent, scope, before);
        const result = await f.read(agent, scope);
        assert.equal(
          result.state,
          'invalid',
          `${agent}/${scope}: ambiguous source must not be present`,
        );
        assert.equal(result.reason, 'config-invalid');
        assert.deepEqual(result.events, []);
        assert.deepEqual(await readFile(f.file(agent, scope)), before);
      }
    }
  await assert.rejects(access(join(f.userHome, '.stroq')), { code: 'ENOENT' });
});

test('strict status preserves valid BOM/CRLF and legacy Codex root groups without normalizing files', async (t) => {
  const f = await fixture(t);
  const expected = f.expected('codex');
  for (const shape of ['array', 'group'])
    for (const scope of ['project', 'user']) {
      const config = { PRIVATE_PARSE_FIELD: true };
      for (const [event, groups] of Object.entries(expected.hooks))
        config[event] = shape === 'array' ? groups : groups[0];
      const before = Buffer.from(
        '\uFEFF' + JSON.stringify(config, null, '\t').replaceAll('\n', '\r\n') + '\r\n',
      );
      await f.write('codex', scope, before);
      const result = await f.read('codex', scope);
      assert.equal(result.state, 'present');
      assert.equal(result.reason, 'matches-current-install');
      assert.ok(result.events.every((event) => event.state === 'present'));
      assert.deepEqual(await readFile(f.file('codex', scope)), before);
    }
  await assert.rejects(access(join(f.userHome, '.stroq')), { code: 'ENOENT' });
});

test('a refused unsafe source remains unknown and a missing source remains missing', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.read('claude-code', 'project')).state, 'missing');
  const target = join(f.directory, 'private-target.json');
  const bytes = JSON.stringify(f.expected('claude-code'));
  await writeFile(target, bytes);
  await mkdir(dirname(f.file('claude-code', 'project')), { recursive: true });
  await symlink(target, f.file('claude-code', 'project'));
  const result = await f.read('claude-code', 'project');
  assert.equal(result.state, 'unknown');
  assert.equal(result.reason, 'config-unreadable');
  assert.equal(await readFile(target, 'utf8'), bytes);
});
