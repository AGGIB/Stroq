import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInventory } from './inventory.mjs';
import { createSkillQuarantine } from './skill-quarantine.mjs';

export async function fixture(t, options = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-quarantine-test-')));
  const project = join(dir, 'project');
  const userHome = join(dir, 'user');
  await mkdir(project);
  await mkdir(userHome);
  const inventory = createInventory({ project, userHome });
  const quarantine = createSkillQuarantine({
    project,
    userHome,
    runtimeDigest: async () => 'a'.repeat(64),
    ...options,
  });
  t.after(async () => {
    await quarantine.close();
    await inventory.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, project, userHome, inventory, quarantine };
}
export async function skill(
  f,
  scope = 'project',
  name = 'notes',
  content = '# Release notes\nSummarize the changes.',
) {
  const root = scope === 'project' ? f.project : f.userHome;
  const directory = join(root, '.claude', 'skills', name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), content);
  return directory;
}
export async function preview(f, name = 'notes') {
  const state = await f.inventory.read();
  assert.equal(state.status, 200);
  const item = state.body.items.find((item) => item.name === name);
  assert.ok(item);
  const result = await f.quarantine.preview({
    action: 'quarantine',
    id: item.id,
    expectedSha256: item.sha256,
  });
  return { item, ...result };
}
export const apply = (service, preview) =>
  service.apply({ previewId: preview.id, confirm: true, acknowledgeSessionLimits: true });
export const vault = (root, recordId) => join(root, '.claude', '.stroq-quarantine', recordId);
