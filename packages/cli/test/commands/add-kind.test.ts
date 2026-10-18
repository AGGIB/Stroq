import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAdd } from '../../src/commands/add.js';
import * as skillInstall from '../../src/install/skill-install.js';
import * as mcpInstall from '../../src/install/mcp-install.js';
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
  it.each([{ kind: [] }, { kind: ['--kind', 'skill'] }])(
    'refuses strict for an inferred or explicit skill (%j)',
    async ({ kind }) => {
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      expect(await runAdd(['./somewhere', ...kind, '--strict'])).toBe(2);
      expect(write.mock.calls.map(([text]) => String(text)).join('')).toContain('--strict');
    },
  );
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

describe('add --kind mcp --strict', () => {
  it('passes an explicit request, and leaves an absent request absent for recorded inheritance', async () => {
    const seen: (boolean | undefined)[] = [];
    vi.spyOn(mcpInstall, 'addMcp').mockImplementation(async (_source, options) => {
      seen.push(options.strict);
      return { digest: 'a'.repeat(64) } as never;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runAdd(['./somewhere', '--kind', 'mcp', '--config', './client.json', '--strict']);
    await runAdd(['demo', '--kind', 'mcp']);
    expect(seen).toEqual([true, undefined]);
  });
});

describe('add --kind mcp from an npx cache entry', () => {
  it('writes a stable entry path outside _npx and records the same launch in the lock', async () => {
    const { readFile } = await import('node:fs/promises');
    const { mcpFixture } = await import('../helpers/mcp-install.js');
    const { readPassports } = await import('../../src/install/lock.js');
    const { storePath } = await import('../../src/install/store.js');
    const { preparePin } = await import('../../src/mcp/pin.js');
    const { configPinStatus } = await import('../../src/mcp/pin-status.js');
    const { wrappedEntryPath } = await import('../../src/commands/mcp-config.js');
    const terminal = await import('../../src/ui/terminal.js');

    const f = await mcpFixture();
    const npxEntry = join(
      f.root,
      '_npx',
      'deadbeef',
      'node_modules',
      '@stroq',
      'cli',
      'dist',
      'index.js',
    );
    await mkdir(join(npxEntry, '..'), { recursive: true });
    await writeFile(npxEntry, '// cli entry\n');

    vi.stubEnv('STROQ_HOME', f.options.stroqHome);
    vi.spyOn(process, 'cwd').mockReturnValue(f.options.project);
    vi.spyOn(terminal, 'currentTerminal').mockReturnValue(f.terminal);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const prevArgv1 = process.argv[1];
    process.argv[1] = npxEntry;
    try {
      expect(await runAdd([f.dir, '--kind', 'mcp', '--config', f.config])).toBe(0);
    } finally {
      process.argv[1] = prevArgv1!;
    }

    // Even after npm prunes the temporary _npx cache folder, the installed wrapper's entry exists.
    await rm(join(f.root, '_npx'), { recursive: true, force: true });

    const servers = await f.servers();
    const wrapper = servers['demo'] as { command: string; args: string[] };
    const entryPath = wrappedEntryPath(wrapper.args)!;
    expect(entryPath).toBeDefined();
    expect(entryPath).not.toContain('_npx');
    expect(entryPath).toContain(join(f.options.stroqHome, 'cli'));
    expect(await readFile(entryPath, 'utf8')).toBe('// cli entry\n');

    const lock = await readPassports(f.options.stroqHome);
    const record = lock.mcp!['demo'] as { written: unknown; digest: string };
    expect(record.written).toEqual(wrapper);

    const pinned = await preparePin({
      home: f.options.stroqHome,
      server: 'demo',
      pin: `sha256:${record.digest}`,
      command: 'node',
      args: [join(storePath(f.options.stroqHome, record.digest), 'tree', 'server.js')],
      passEnv: [],
      launch: { command: wrapper.command, argv: wrapper.args },
    });
    await pinned.cleanup();
    expect(await configPinStatus(f.config)).toMatchObject([{ name: 'mcp pin "demo"', ok: true }]);

    // If the recorded entry path is later deleted, configPinStatus fails and says what to run.
    await rm(entryPath);
    const broken = await configPinStatus(f.config);
    expect(broken).toMatchObject([
      {
        name: 'mcp pin "demo"',
        ok: false,
        detail: expect.stringContaining('stroq add demo --kind mcp --force'),
      },
    ]);
    expect(broken[0]!.detail).toContain('no longer exists');
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
