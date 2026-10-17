import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAdd } from '../../src/commands/add.js';
import * as skillInstall from '../../src/install/skill-install.js';
import { addSkill } from '../../src/install/skill-install.js';
import { setup } from '../helpers/skill-install.js';

afterEach(() => vi.restoreAllMocks());

/**
 * `add --kind skill` is what a person is told to say when a folder looks like two kinds of artifact (a
 * skill and an MCP server: SKILL.md beside .mcp.json). It used to be parsed and thrown away, and the advice
 * of the error was circular.
 */
async function both() {
  const f = await setup();
  await writeFile(
    join(f.source, '.mcp.json'),
    JSON.stringify({ mcpServers: { s: { command: 'x' } } }),
  );
  return f;
}

describe('add --kind skill', () => {
  it('is passed to the install, and an add without --kind leaves the kind to the files', async () => {
    const seen: unknown[] = [];
    vi.spyOn(skillInstall, 'addSkill').mockImplementation(async (_source, options) => {
      seen.push((options as { kind?: string }).kind);
      return { digest: 'a'.repeat(64) } as never;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runAdd(['./somewhere', '--kind', 'skill']);
    await runAdd(['./somewhere']);

    expect(seen).toEqual(['skill', undefined]);
  });

  it('installs a folder that is a skill and has an MCP configuration beside it', async () => {
    const f = await both();

    const added = await addSkill(f.source, { ...f.options, kind: 'skill' });

    expect(added.kind).toBe('skill');
    expect(f.prompts()).toBe(1);
    expect(f.output()).toMatch(/^Install demo/);
  });

  it('keeps asking the files when no kind is given, and the error says which flag to use', async () => {
    const f = await both();

    const error = await addSkill(f.source, f.options).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/more than one kind/);
    expect((error as Error).message).toMatch(/--kind skill/);
    expect(f.prompts()).toBe(0);
  });

  it('is kept for an update of the skill', async () => {
    const f = await both();
    await addSkill(f.source, { ...f.options, kind: 'skill' });
    await writeFile(join(f.source, 'README.md'), 'more\n');

    const updated = await addSkill('demo', { ...f.options, kind: 'skill' });

    expect(updated.history.map((h) => h.action)).toEqual(['add', 'update']);
  });
});

describe('add of a folder that is not a skill', () => {
  it('points an MCP server at --kind mcp, with the flags that name its client', async () => {
    const f = await setup();
    await rm(join(f.source, 'SKILL.md'));
    await writeFile(join(f.source, '.mcp.json'), JSON.stringify({ mcpServers: {} }));

    const error = await addSkill(f.source, f.options).catch((e: Error) => e);

    expect((error as Error).message).toMatch(/MCP server/);
    expect((error as Error).message).toContain('--kind mcp');
    expect((error as Error).message).toMatch(/--client <name>|--config <path>/);
    expect(f.prompts()).toBe(0);
  });

  it('says that a plugin is read with vet and is not installed by add', async () => {
    const f = await setup();
    await rm(join(f.source, 'SKILL.md'));
    await mkdir(join(f.source, '.claude-plugin'));
    await writeFile(join(f.source, '.claude-plugin', 'plugin.json'), '{"name":"p"}');

    const error = await addSkill(f.source, f.options).catch((e: Error) => e);

    expect((error as Error).message).toMatch(/plugin/);
    expect((error as Error).message).toContain('stroq vet');
    expect((error as Error).message).not.toContain('--kind mcp');
  });
});
