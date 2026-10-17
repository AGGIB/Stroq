import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPassports } from '../../src/install/lock.js';
import { addMcp, removeMcp } from '../../src/install/mcp-install.js';
import { addSkill, removeSkill } from '../../src/install/skill-install.js';
import { storePath } from '../../src/install/store.js';
import { mcpFixture } from '../helpers/mcp-install.js';
import { setup } from '../helpers/skill-install.js';

/**
 * A damaged store (a byte appended, a file gone, a cleanup tool) must not make an installed server or skill
 * impossible to take out. Removing needs the digest from the lock and nothing from the bytes; the commands
 * that do need the stored bytes (an update compares with them, a restore writes them) refuse with the way
 * out: remove it with --force, then add it again from its source.
 */
const MCP_REMEDY =
  /stroq remove demo --kind mcp --force, then stroq add \S+ --kind mcp --name demo --config \S+ --entrypoint server\.js/;
const SKILL_REMEDY = /stroq remove demo --force, then stroq add \S+$/;

const damages = [
  [
    'a byte appended to a file',
    async (store: string) => appendFile(join(store, 'tree', 'server.js'), '// x\n'),
  ],
  ['a file gone', async (store: string) => rm(join(store, 'tree', 'server.js'))],
  ['the manifest gone', async (store: string) => rm(join(store, 'manifest.json'))],
  ['the manifest not JSON', async (store: string) => writeFile(join(store, 'manifest.json'), 'x')],
  ['the whole copy gone', async (store: string) => rm(store, { recursive: true })],
] as const;

async function installedServer() {
  const f = await mcpFixture();
  const record = await addMcp(f.dir, f.mcpOptions);
  const store = storePath(f.options.stroqHome, record.digest);
  const entries = async () => Object.keys(await f.servers());
  return { f, record, store, entries };
}

describe.each(damages)('an MCP server whose stored copy has %s', (_what, damage) => {
  it('is removed with a y/N, from the digest in the lock', async () => {
    const { f, store, entries } = await installedServer();
    await damage(store);

    await removeMcp('demo', f.mcpOptions);

    expect(await entries()).toEqual(['other']);
    expect((await readPassports(f.options.stroqHome)).mcp?.['demo']).toMatchObject({
      status: 'revoked',
    });
  });

  it('is removed with --force too, and its entry restored to the one before', async () => {
    const { f, store, entries } = await installedServer();
    await damage(store);

    await removeMcp('demo', { ...f.mcpOptions, force: true });

    expect(await entries()).toEqual(['other']);
  });

  it('cannot be restored, and says to remove it with --force and add it again', async () => {
    const { f, store, entries } = await installedServer();
    await damage(store);
    const config = await readFile(f.config, 'utf8');

    await expect(addMcp('demo', { ...f.mcpOptions, restore: true })).rejects.toThrow(MCP_REMEDY);

    expect(await readFile(f.config, 'utf8')).toBe(config);
    expect(await entries()).toContain('demo');
  });

  it('cannot be updated, and says to remove it with --force and add it again', async () => {
    const { f, store } = await installedServer();
    await damage(store);
    await writeFile(join(f.dir, 'server.js'), 'console.log("two");\n');
    const config = await readFile(f.config, 'utf8');
    const lock = await readFile(join(f.options.stroqHome, 'passports.json'), 'utf8');

    await expect(addMcp('demo', f.mcpOptions)).rejects.toThrow(MCP_REMEDY);

    expect(await readFile(f.config, 'utf8')).toBe(config);
    expect(await readFile(join(f.options.stroqHome, 'passports.json'), 'utf8')).toBe(lock);
  });

  it('is installed again from its source after it is removed', async () => {
    const { f, store, entries } = await installedServer();
    await damage(store);
    await removeMcp('demo', { ...f.mcpOptions, force: true });

    await addMcp(f.dir, f.mcpOptions);

    expect(await entries()).toContain('demo');
  });
});

describe.each(damages.slice(0, 3))('a skill whose stored copy has %s', (_what, damageMcp) => {
  const damage = async (store: string) =>
    damageMcp(store).catch(() => undefined) as Promise<unknown>;

  async function installedSkill() {
    const f = await setup();
    const record = await addSkill(f.source, f.options);
    const store = storePath(f.options.stroqHome, record.digest);
    // The skill has SKILL.md, not server.js: damage the file it has.
    await appendFile(join(store, 'tree', 'SKILL.md'), '\nx\n');
    await damage(store);
    return { f, record };
  }

  it('is removed from the digest in the lock', async () => {
    const { f } = await installedSkill();

    await removeSkill('demo', f.options);

    expect((await readPassports(f.options.stroqHome)).skills['demo']?.status).toBe('revoked');
  });

  it('cannot be restored or updated, and says to remove it with --force and add it again', async () => {
    const { f } = await installedSkill();
    await writeFile(join(f.source, 'README.md'), 'more\n');

    await expect(addSkill('demo', { ...f.options, restore: true })).rejects.toThrow(SKILL_REMEDY);
    await expect(addSkill('demo', f.options)).rejects.toThrow(SKILL_REMEDY);
    expect((await readPassports(f.options.stroqHome)).skills['demo']?.status).toBe('confirmed');
  });
});
