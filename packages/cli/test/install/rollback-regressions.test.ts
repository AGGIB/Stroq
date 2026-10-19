import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPassports, writePassports } from '../../src/install/lock.js';
import { addMcp } from '../../src/install/mcp-install.js';
import { checkRetainedRevisions } from '../../src/install/previous-revisions.js';
import { addSkill } from '../../src/install/skill-install.js';
import { storePath } from '../../src/install/store.js';
import { mcpFixture } from '../helpers/mcp-install.js';
import { setup } from '../helpers/skill-install.js';

describe('rollback confirmation and retained store integrity', () => {
  it('names the orphan that could not be collected, never the retained rollback revision', async () => {
    const f = await setup();
    const first = await addSkill(f.source, f.options);
    const orphan = 'f'.repeat(64);
    const elsewhere = join(f.root, 'elsewhere');
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, 'keep.txt'), 'keep');
    await symlink(elsewhere, storePath(f.options.stroqHome, orphan), 'junction');
    await writeFile(join(f.source, 'README.md'), 'Updated documentation.\n');
    const updated = await addSkill('demo', f.options);
    expect(updated.previous?.digest).toBe(first.digest);
    const warnings = f
      .output()
      .split('\n')
      .filter((line) => line.startsWith('warning:'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(orphan.slice(0, 12));
    expect(warnings[0]).not.toContain(first.digest.slice(0, 12));
    expect(await readFile(join(elsewhere, 'keep.txt'), 'utf8')).toBe('keep');
    expect(await checkRetainedRevisions(f.options.stroqHome)).toEqual([
      expect.objectContaining({ ok: true }),
    ]);
  });

  it('requires a typed digest even when only ordinary documentation changed', async () => {
    const f = await setup();
    await writeFile(join(f.source, 'README.md'), 'Ordinary project documentation.\n');
    const first = await addSkill(f.source, f.options);
    await writeFile(join(f.source, 'README.md'), 'Updated ordinary project documentation.\n');
    const second = await addSkill('demo', f.options);
    const prompts: string[] = [];
    const terminal = {
      ...f.terminal,
      readLine: async (prompt: string) => {
        prompts.push(prompt);
        return 'y';
      },
    };

    await expect(addSkill('demo', { ...f.options, terminal, rollback: true })).rejects.toThrow(
      /not confirmed/,
    );
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain('12');
    expect((await readPassports(f.options.stroqHome)).skills['demo']?.digest).toBe(second.digest);
    expect(await readFile(join(second.installedTo, 'README.md'), 'utf8')).toContain('Updated');

    const rolled = await addSkill('demo', { ...f.options, rollback: true });
    expect(rolled.digest).toBe(first.digest);
    expect(await readFile(join(rolled.installedTo, 'README.md'), 'utf8')).toBe(
      'Ordinary project documentation.\n',
    );
  });

  it('restores the old wrapper cwd when the retained legacy record lacks a cwd field', async () => {
    const f = await mcpFixture();
    const first = await addMcp(f.dir, f.mcpOptions);
    const lock = await readPassports(f.options.stroqHome);
    const { cwd: _cwd, ...legacy } = first;
    await writePassports(f.options.stroqHome, { ...lock, mcp: { demo: legacy } });
    await writeFile(join(f.dir, 'server.js'), 'console.log("two");\n');
    await addMcp('demo', { ...f.mcpOptions, cwd: f.root });

    const rolled = await addMcp('demo', { ...f.mcpOptions, rollback: true });
    expect(rolled.digest).toBe(first.digest);
    expect(rolled.cwd).toBe(f.options.project);
    expect(rolled.written).toEqual(first.written);
  });

  it.each(['missing manifest', 'corrupt manifest', 'missing tree', 'changed bytes'])(
    'doctor rejects a retained revision with %s',
    async (damage) => {
      const f = await setup();
      const first = await addSkill(f.source, f.options);
      await writeFile(join(f.source, 'README.md'), 'New documentation.\n');
      await addSkill('demo', f.options);
      const folder = storePath(f.options.stroqHome, first.digest);
      if (damage === 'missing manifest') await rm(join(folder, 'manifest.json'));
      if (damage === 'corrupt manifest') await writeFile(join(folder, 'manifest.json'), '{}');
      if (damage === 'missing tree') await rm(join(folder, 'tree'), { recursive: true });
      if (damage === 'changed bytes') await writeFile(join(folder, 'tree', 'SKILL.md'), 'changed');

      expect(await checkRetainedRevisions(f.options.stroqHome)).toEqual([
        expect.objectContaining({ name: 'previous revisions', ok: false }),
      ]);
      await expect(addSkill('demo', { ...f.options, rollback: true })).rejects.toThrow();
    },
  );
});
