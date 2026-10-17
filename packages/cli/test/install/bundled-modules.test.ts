import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addMcp } from '../../src/install/mcp-install.js';
import { addSkill } from '../../src/install/skill-install.js';
import { assertWritableTree } from '../../src/install/store.js';
import { treeDigest } from '../../src/install/tree.js';
import { mcpFixture } from '../helpers/mcp-install.js';
import { setup } from '../helpers/skill-install.js';
import { tgzOf } from '../helpers/tar-writer.js';
import { treeOf } from '../helpers/install-tree.js';

/**
 * The store is read back through a reader that leaves `node_modules` out (a folder's `node_modules` is
 * somebody else's code that is fetched and not shipped), so a tree that holds one cannot be installed as the
 * bytes that were confirmed: the typed digest would be accepted and the store refused the copy. A tarball
 * made by `npm pack` with bundled dependencies is such a tree. It is refused at inspection, before a prompt.
 */
const MESSAGE = /node_modules/;

describe('a source with a node_modules folder in it', () => {
  it.each([
    'node_modules/dep/index.js',
    'node_modules/dep/package.json',
    'lib/node_modules/dep/index.js',
    'NODE_MODULES/dep/index.js',
    'Node_Modules/dep/index.js',
  ])('cannot be written to the store (%s)', (path) => {
    const tree = treeOf({ 'SKILL.md': '# demo', [path]: 'x' });

    expect(() => assertWritableTree(tree, treeDigest(tree))).toThrow(MESSAGE);
  });

  it('is fine when node_modules is only part of a longer name', () => {
    const tree = treeOf({
      'SKILL.md': '# demo',
      'my_node_modules/x.js': 'x',
      'node_modules.md': 'x',
    });

    expect(() => assertWritableTree(tree, treeDigest(tree))).not.toThrow();
  });

  it('is refused for a skill from an archive, before a prompt, and nothing is written', async () => {
    const f = await setup();
    const archive = join(f.root, 'skill.tgz');
    await writeFile(
      archive,
      tgzOf([
        { name: 'SKILL.md', data: '---\nname: demo\ndescription: d\n---\n# demo\n' },
        { name: 'node_modules/dep/index.js', data: 'module.exports = 1' },
      ]),
    );

    await expect(addSkill(archive, f.options)).rejects.toThrow(MESSAGE);

    expect(f.prompts()).toBe(0);
    await expect(access(join(f.options.stroqHome, 'store'))).rejects.toThrow();
    await expect(access(join(f.options.project, '.claude', 'skills', 'demo'))).rejects.toThrow();
  });

  it('is refused for an MCP server from an archive, before a prompt, and nothing is written', async () => {
    const f = await mcpFixture();
    const archive = join(f.root, 'server.tgz');
    await writeFile(
      archive,
      tgzOf([
        {
          name: 'package.json',
          data: JSON.stringify({ name: 'demo', version: '1.0.0', bin: 'server.js' }),
        },
        { name: 'server.js', data: 'console.log(1)\n' },
        { name: 'node_modules/dep/index.js', data: 'module.exports = 1' },
      ]),
    );
    const config = await readFile(f.config, 'utf8');

    await expect(addMcp(archive, f.mcpOptions)).rejects.toThrow(MESSAGE);

    expect(f.prompts()).toBe(0);
    expect(await readFile(f.config, 'utf8')).toBe(config);
    await expect(access(join(f.options.stroqHome, 'store'))).rejects.toThrow();
  });

  it('is still left out, with a blind spot, when it is a folder on disk', async () => {
    const f = await setup();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(f.source, 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(f.source, 'node_modules', 'dep', 'index.js'), 'x');

    await addSkill(f.source, f.options);

    expect(f.output()).toMatch(/node_modules entry was left out/);
    expect(f.prompts()).toBe(1);
  });
});
