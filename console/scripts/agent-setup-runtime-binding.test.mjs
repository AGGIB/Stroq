import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { join } from 'node:path';
import { test } from 'node:test';
import { createAgentSetup } from './agent-setup.mjs';

// An inert private adapter isolates the service's commit lifecycle from shared build artifacts.
const ADAPTER = `
const events = ['preToolUse','beforeShellExecution','afterShellExecution','beforeMCPExecution','afterMCPExecution','beforeReadFile','afterFileEdit'];
const blocking = new Set(['preToolUse','beforeShellExecution','beforeMCPExecution']);
export const parseSetupObject = (value) => value === null ? {} : JSON.parse(typeof value === 'string' ? value : new TextDecoder().decode(value));
export const expectedConfiguration = (_agent, command) => ({version:1,hooks:Object.fromEntries(events.map(event => [event,[{command,timeout:15,failClosed:blocking.has(event)}]]))});
export function prepareAgentSetup(text, agent, command) {
  const current = parseSetupObject(text), expected = expectedConfiguration(agent,command);
  return {candidateText:JSON.stringify({...current,...expected}),addedHooks:events.length,preservedHooks:0,replacedHooks:0,remainingLookalikes:0,
    hookEvents:events.map(event => ({event,matcher:null,blocking:blocking.has(event),failClosed:blocking.has(event),timeoutSeconds:15}))};
}
`;

test('Connect refuses a success receipt when runtime changes after its final precommit capture', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'stroq-setup-runtime-binding-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'workspace');
  const userHome = join(directory, 'profile');
  const engine = join(directory, 'engine');
  await Promise.all([
    mkdir(join(project, '.cursor'), { recursive: true }),
    mkdir(userHome),
    mkdir(engine),
  ]);
  const cli = join(engine, 'index.js');
  const core = join(engine, 'core.js');
  const packageFile = join(engine, 'package.json');
  const adapterPath = join(engine, 'adapter.mjs');
  const file = join(project, '.cursor/hooks.json');
  const before = Buffer.from('{"PRIVATE_SETTING":"retain"}');
  await Promise.all([
    writeFile(cli, "process.stdout.write('0.28.0\\n');"),
    writeFile(core, '/* inert core */'),
    writeFile(packageFile, '{"version":"0.28.0"}'),
    writeFile(adapterPath, ADAPTER),
    writeFile(file, before),
  ]);
  let captures = 0;
  let revision = 'a'.repeat(64);
  const service = await createAgentSetup({
    project,
    userHome,
    environment: {},
    paths: { cli, core, package: packageFile },
    adapterPath,
    // The pure generation/protocol suites exercise real schemas. This case isolates runtime pinning.
    loadSchema: async () => ({ validateSetupPreview: () => true, validateSetupResult: () => true }),
    runtimeDigest: async () => {
      const captured = revision;
      captures += 1;
      // Preview captures twice; apply captures before the lock and again inside it.
      // A concurrent rebuild now changes the runtime after the last captured value was read.
      if (captures === 4) revision = 'b'.repeat(64);
      return captured;
    },
  });
  t.after(() => service.close());
  const preview = await service.preview({ agent: 'cursor', scope: 'project' });
  assert.equal(preview.status, 200, JSON.stringify(preview));
  assert.equal(captures, 2);
  const applied = await service.apply({
    previewId: preview.body.id,
    confirm: true,
    acknowledgeRetainedCopy: true,
  });
  assert.equal(applied.status, 409, JSON.stringify(applied));
  assert.deepEqual(applied.body, { error: 'preview-stale' });
  assert.ok(captures >= 5, 'runtime must be compared after the committed bytes are checked');
  const backup = join(userHome, '.stroq/backups/console-setup', `${preview.body.id}.config.json`);
  assert.deepEqual(await readFile(backup), before);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).PRIVATE_SETTING, 'retain');
  assert.ok(!JSON.stringify(applied).includes(directory));
});

test('a canonical home-as-workspace alias requires shared consent without consuming its preview', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'stroq-setup-home-alias-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const userHome = join(directory, 'profile');
  const project = join(directory, 'workspace-alias');
  const engine = join(directory, 'engine');
  await Promise.all([mkdir(join(userHome, '.cursor'), { recursive: true }), mkdir(engine)]);
  await symlink(userHome, project, 'dir');
  const cli = join(engine, 'index.js');
  const core = join(engine, 'core.js');
  const packageFile = join(engine, 'package.json');
  const adapterPath = join(engine, 'adapter.mjs');
  const file = join(userHome, '.cursor/hooks.json');
  const before = Buffer.from('{"PRIVATE_SETTING":"retain"}');
  await Promise.all([
    writeFile(cli, "process.stdout.write('0.28.0\\n');"),
    writeFile(core, '/* inert core */'),
    writeFile(packageFile, '{"version":"0.28.0"}'),
    writeFile(adapterPath, ADAPTER),
    writeFile(file, before),
  ]);
  // Use the actual built boundary validators; this fixture never starts a real host.
  const schema = await import('../.local-engine/local-api-schema.js');
  const service = await createAgentSetup({
    project,
    userHome,
    environment: {},
    paths: { cli, core, package: packageFile },
    adapterPath,
    runtimeDigest: async () => 'a'.repeat(64),
  });
  t.after(() => service.close());
  assert.equal(schema.validateSetupState(service.getState()), true);
  const preview = await service.preview({ agent: 'cursor', scope: 'project' });
  assert.equal(preview.status, 200, JSON.stringify(preview));
  assert.equal(schema.validateSetupPreview(preview.body), true);
  assert.equal(preview.body.scopeImpact, 'all-workspaces');
  assert.equal(preview.body.target, '~/.cursor/hooks.json');
  assert.equal(preview.body.context, 'This user');
  assert.equal(
    preview.body.workspaceId,
    `workspace-${createHash('sha256').update(userHome).digest('hex').slice(0, 24)}`,
  );
  assert.deepEqual(preview.body.needs, {
    acknowledgeRetainedCopy: true,
    acknowledgeSharedScope: true,
  });
  const refused = await service.apply({
    previewId: preview.body.id,
    confirm: true,
    acknowledgeRetainedCopy: true,
  });
  assert.equal(refused.status, 400, JSON.stringify(refused));
  assert.deepEqual(await readFile(file), before);
  await assert.rejects(access(join(userHome, '.stroq')), { code: 'ENOENT' });
  const applied = await service.apply({
    previewId: preview.body.id,
    confirm: true,
    acknowledgeRetainedCopy: true,
    acknowledgeSharedScope: true,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied));
  assert.equal(schema.validateSetupResult(applied.body), true);
  assert.equal(applied.body.previewId, preview.body.id);
  assert.equal(applied.body.scopeImpact, 'all-workspaces');
  assert.equal(applied.body.target, '~/.cursor/hooks.json');
  assert.equal(applied.body.context, 'This user');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).PRIVATE_SETTING, 'retain');
  assert.deepEqual(
    await readFile(
      join(userHome, '.stroq/backups/console-setup', `${preview.body.id}.config.json`),
    ),
    before,
  );
});
