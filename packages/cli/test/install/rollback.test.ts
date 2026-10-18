import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addSkill, removeSkill } from '../../src/install/skill-install.js';
import { addMcp, removeMcp } from '../../src/install/mcp-install.js';
import { readPassports } from '../../src/install/lock.js';
import { storePath } from '../../src/install/store.js';
import { doctorReport } from '../../src/commands/doctor.js';
import { setup } from '../helpers/skill-install.js';
import { mcpFixture } from '../helpers/mcp-install.js';

describe('Safe Install rollback: skills', () => {
  it('retains one previous revision across updates and rolls back cleanly with a receipt', async () => {
    const f = await setup();
    const first = await addSkill(f.source, f.options);
    const firstFile = storePath(f.options.stroqHome, first.digest);
    expect(existsSync(firstFile)).toBe(true);

    // Update to v2: modifying the description requires typed confirmation
    await writeFile(
      join(f.source, 'SKILL.md'),
      '---\nname: demo\ndescription: an updated demo\n---\n# Demo\nUpdated content.\n',
    );
    const second = await addSkill(f.source, f.options);
    expect(second.digest).not.toBe(first.digest);

    // Both current v2 and retained v1 exist in store
    expect(existsSync(firstFile)).toBe(true);
    expect(existsSync(storePath(f.options.stroqHome, second.digest))).toBe(true);

    const lockAfterUpdate = await readPassports(f.options.stroqHome);
    expect(lockAfterUpdate.skills['demo']?.previous?.digest).toBe(first.digest);

    // Doctor reports the retained previous revision and byte size
    const report = await doctorReport(f.options.project, { home: f.options.stroqHome });
    const prevCheck = report.checks.find((c) => c.name === 'previous revisions');
    expect(prevCheck).toBeDefined();
    expect(prevCheck?.ok).toBe(true);
    expect(prevCheck?.detail).toContain('1 previous revision retained');
    expect(prevCheck?.detail).toContain('skill "demo"');
    expect(prevCheck?.detail).toContain(first.digest.slice(0, 12));

    // Roll back to v1
    const rolled = await addSkill('demo', { ...f.options, rollback: true });
    expect(rolled.digest).toBe(first.digest);
    expect(rolled.previous).toBeUndefined();
    expect(rolled.history.at(-1)?.action).toBe('rollback');
    expect(rolled.history.at(-1)?.from).toBe(second.digest);
    expect(rolled.history.at(-1)?.to).toBe(first.digest);

    // Installed file on disk matches v1
    const installedSkill = await readFile(join(rolled.installedTo, 'SKILL.md'), 'utf8');
    expect(installedSkill).toContain('Read the project.');
  });

  it('keeps only the immediately preceding revision when updated twice', async () => {
    const f = await setup();
    const v1 = await addSkill(f.source, f.options);
    const v1Path = storePath(f.options.stroqHome, v1.digest);

    await writeFile(join(f.source, 'SKILL.md'), '---\nname: demo\ndescription: v2\n---\n');
    const v2 = await addSkill(f.source, f.options);
    const v2Path = storePath(f.options.stroqHome, v2.digest);
    expect(existsSync(v1Path)).toBe(true);
    expect(existsSync(v2Path)).toBe(true);

    await writeFile(join(f.source, 'SKILL.md'), '---\nname: demo\ndescription: v3\n---\n');
    const v3 = await addSkill(f.source, f.options);
    const v3Path = storePath(f.options.stroqHome, v3.digest);

    // v1 is garbage collected, v2 (previous) and v3 (current) are kept
    expect(existsSync(v1Path)).toBe(false);
    expect(existsSync(v2Path)).toBe(true);
    expect(existsSync(v3Path)).toBe(true);

    const lock = await readPassports(f.options.stroqHome);
    expect(lock.skills['demo']?.previous?.digest).toBe(v2.digest);
  });

  it('removes both active and previous revisions when skill is removed', async () => {
    const f = await setup();
    const v1 = await addSkill(f.source, f.options);
    await writeFile(join(f.source, 'SKILL.md'), '---\nname: demo\ndescription: v2\n---\n');
    const v2 = await addSkill(f.source, f.options);

    const v1Path = storePath(f.options.stroqHome, v1.digest);
    const v2Path = storePath(f.options.stroqHome, v2.digest);
    expect(existsSync(v1Path)).toBe(true);
    expect(existsSync(v2Path)).toBe(true);

    await removeSkill('demo', f.options);
    expect(existsSync(v1Path)).toBe(false);
    expect(existsSync(v2Path)).toBe(false);
  });

  it('refuses rollback when item has no previous revision', async () => {
    const f = await setup();
    await addSkill(f.source, f.options);
    await expect(addSkill('demo', { ...f.options, rollback: true })).rejects.toThrow(
      /has no previous revision to roll back to/,
    );
  });
});

describe('Safe Install rollback: MCP servers', () => {
  it('retains one previous MCP revision across updates and rolls back cleanly', async () => {
    const f = await mcpFixture({ 'server.js': 'console.log("v1");\n' });
    const first = await addMcp(f.dir, f.mcpOptions);
    const firstStore = storePath(f.options.stroqHome, first.digest);
    expect(existsSync(firstStore)).toBe(true);

    // Update to v2
    await writeFile(join(f.dir, 'server.js'), 'console.log("v2");\n');
    const second = await addMcp(f.dir, f.mcpOptions);
    expect(second.digest).not.toBe(first.digest);
    expect(existsSync(firstStore)).toBe(true);
    expect(existsSync(storePath(f.options.stroqHome, second.digest))).toBe(true);

    const lockAfterUpdate = await readPassports(f.options.stroqHome);
    const mcpRecord = lockAfterUpdate.mcp?.['demo'] as { previous?: { digest: string } };
    expect(mcpRecord?.previous?.digest).toBe(first.digest);

    // Rollback to v1
    const rolled = await addMcp('demo', { ...f.mcpOptions, rollback: true });
    expect(rolled.digest).toBe(first.digest);
    expect(rolled.previous).toBeUndefined();
    expect(rolled.history.at(-1)?.action).toBe('rollback');

    // Written client config wrapper points to first digest pin
    const servers = await f.servers();
    expect(JSON.stringify(servers['demo'])).toContain(`sha256:${first.digest}`);
  });

  it('removes both active and previous revisions when MCP server is removed', async () => {
    const f = await mcpFixture({ 'server.js': 'console.log("v1");\n' });
    const v1 = await addMcp(f.dir, f.mcpOptions);
    await writeFile(join(f.dir, 'server.js'), 'console.log("v2");\n');
    const v2 = await addMcp(f.dir, f.mcpOptions);

    const v1Path = storePath(f.options.stroqHome, v1.digest);
    const v2Path = storePath(f.options.stroqHome, v2.digest);
    expect(existsSync(v1Path)).toBe(true);
    expect(existsSync(v2Path)).toBe(true);

    await removeMcp('demo', f.mcpOptions);
    expect(existsSync(v1Path)).toBe(false);
    expect(existsSync(v2Path)).toBe(false);
  });
});
