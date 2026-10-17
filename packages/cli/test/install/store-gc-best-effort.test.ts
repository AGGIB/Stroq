import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPassports } from '../../src/install/lock.js';
import { addMcp, removeMcp } from '../../src/install/mcp-install.js';
import { addSkill, removeSkill } from '../../src/install/skill-install.js';
import { storePath } from '../../src/install/store.js';
import { tidyStore } from '../../src/install/store-gc.js';
import { mcpFixture } from '../helpers/mcp-install.js';
import { setup } from '../helpers/skill-install.js';

/**
 * Clearing the old stored copy is the last step of a removal or an update, after the config and the lock have been
 * written. A copy that cannot be cleared (a link where the folder should be, a folder that cannot be written) is a
 * leftover and not a failure: the command already did what it was asked, so it warns, keeps the copy, and succeeds.
 */
const canRestrict = process.platform !== 'win32' && process.getuid?.() !== 0;

/** Makes the folder of a stored copy a link to somewhere else, as a damaged or hostile store may have it. */
async function replaceWithLink(root: string, store: string): Promise<string> {
  const elsewhere = join(root, 'elsewhere');
  await mkdir(elsewhere);
  await writeFile(join(elsewhere, 'keep.txt'), 'kept');
  await rm(store, { recursive: true });
  await symlink(elsewhere, store);
  return elsewhere;
}

describe('removing a server whose old stored copy cannot be cleared', () => {
  it('succeeds, warns, and does not follow the link', async () => {
    const f = await mcpFixture();
    const record = await addMcp(f.dir, f.mcpOptions);
    const elsewhere = await replaceWithLink(f.root, storePath(f.options.stroqHome, record.digest));

    await removeMcp('demo', f.mcpOptions);

    expect(Object.keys(await f.servers())).toEqual(['other']);
    expect((await readPassports(f.options.stroqHome)).mcp?.['demo']).toMatchObject({
      status: 'revoked',
    });
    expect(f.output()).toMatch(/warning: .*stored copy.*not removed/);
    expect(f.output()).toContain(record.digest.slice(0, 12));
    expect(await readFile(join(elsewhere, 'keep.txt'), 'utf8')).toBe('kept');
  });
});

describe('removing a skill whose old stored copy cannot be cleared', () => {
  it('succeeds and warns', async () => {
    const f = await setup();
    const record = await addSkill(f.source, f.options);
    await replaceWithLink(f.root, storePath(f.options.stroqHome, record.digest));

    await removeSkill('demo', f.options);

    expect((await readPassports(f.options.stroqHome)).skills['demo']?.status).toBe('revoked');
    expect(f.output()).toMatch(/warning: .*stored copy.*not removed/);
  });
});

describe.skipIf(!canRestrict)('updating when the old stored copy cannot be cleared', () => {
  it('commits the update of a server, warns, and keeps the old copy', async () => {
    const f = await mcpFixture();
    const first = await addMcp(f.dir, f.mcpOptions);
    const tree = join(storePath(f.options.stroqHome, first.digest), 'tree');
    await writeFile(join(f.dir, 'server.js'), 'console.log("two");\n');
    await chmod(tree, 0o500);
    try {
      const second = await addMcp('demo', f.mcpOptions);

      expect(second.digest).not.toBe(first.digest);
      expect((await readPassports(f.options.stroqHome)).mcp?.['demo']).toMatchObject({
        digest: second.digest,
        status: 'confirmed',
      });
      expect(f.output()).toMatch(/warning: .*stored copy.*not removed/);
    } finally {
      await chmod(tree, 0o700);
    }
  });

  it('commits the update of a skill, warns, and keeps the old copy', async () => {
    const f = await setup();
    const first = await addSkill(f.source, f.options);
    const tree = join(storePath(f.options.stroqHome, first.digest), 'tree');
    await writeFile(
      join(f.source, 'SKILL.md'),
      '---\nname: demo\ndescription: a demo\n---\n# Two\n',
    );
    await chmod(tree, 0o500);
    try {
      const second = await addSkill('demo', f.options);

      expect(second.digest).not.toBe(first.digest);
      expect(f.output()).toMatch(/warning: .*stored copy.*not removed/);
    } finally {
      await chmod(tree, 0o700);
    }
  });
});

describe('tidyStore', () => {
  const sink = () => {
    const lines: string[] = [];
    return { terminal: { write: (text: string) => void lines.push(text) }, lines };
  };

  it('returns without a word when the clearing works', async () => {
    const { terminal, lines } = sink();

    await tidyStore(terminal, 'a'.repeat(64), async () => undefined);

    expect(lines).toEqual([]);
  });

  it('writes the warning once, with the reason made safe to print, when it throws', async () => {
    const { terminal, lines } = sink();

    await tidyStore(terminal, 'ab'.repeat(32), async () => {
      throw new Error('cannot clear \u001b[2J the copy');
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('abababababab');
    expect(lines[0]).toContain('\\u001b');
    expect(lines[0]).not.toContain('\u001b');
  });
});
