import { lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMcpArgv } from '../../src/commands/mcp.js';
import { commitMcpConfig } from '../../src/install/mcp-config-transaction.js';
import { addMcp, removeMcp } from '../../src/install/mcp-install.js';
import type { McpRecord } from '../../src/install/mcp-install.js';
import { readPassports, writePassports } from '../../src/install/lock.js';
import * as store from '../../src/install/store.js';
import { setup } from '../helpers/skill-install.js';

afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const f = await setup();
  const dir = join(f.root, 'server');
  await mkdir(dir);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'demo', main: 'server.js' }));
  await writeFile(join(dir, 'server.js'), 'console.log("one");\n');
  const config = join(f.root, 'client.json');
  await writeFile(config, JSON.stringify({ mcpServers: {}, owner: 'initial' }));
  const options = {
    project: f.options.project,
    stroqHome: f.options.stroqHome,
    terminal: f.terminal,
    node: process.execPath,
    entryArgv: ['/stroq/dist/index.js'],
  };
  const readConfig = async (file = config) => JSON.parse(await readFile(file, 'utf8'));
  return {
    ...f,
    dir,
    config,
    mcpOptions: { ...options, config },
    clientOptions: options,
    readConfig,
  };
}

function invocation(record: McpRecord) {
  const args = record.written['args'] as string[];
  const parsed = parseMcpArgv(args.slice(args.indexOf('mcp') + 1));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.invocation;
}

describe('MCP updates retain the confirmed client context', () => {
  it.each(['documented', 'ide'] as const)(
    'retains the legacy Windsurf home when discovery switches from the %s config',
    async (layout) => {
      const f = await fixture();
      vi.stubEnv('HOME', f.options.home);
      vi.stubEnv('USERPROFILE', f.options.home);
      const ide = join(f.options.home, '.codeium', 'windsurf', 'mcp_config.json');
      if (layout === 'ide') {
        await mkdir(join(f.options.home, '.codeium', 'windsurf'), { recursive: true });
        await writeFile(ide, '{"mcpServers":{}}');
      }
      const first = await addMcp(f.dir, { ...f.clientOptions, client: 'windsurf' });
      const lock = await readPassports(f.options.stroqHome);
      const { configRoot: _root, ...record } = first;
      await writePassports(f.options.stroqHome, { ...lock, mcp: { ...lock.mcp, demo: record } });
      if (layout === 'documented') {
        await mkdir(join(f.options.home, '.codeium', 'windsurf'));
        await writeFile(ide, '{"mcpServers":{},"owner":"new-ide-config"}');
      } else {
        await rm(ide);
      }
      const updated = await addMcp('demo', {
        ...f.clientOptions,
        restore: layout === 'ide',
        force: layout === 'ide',
      });
      expect(updated.config).toBe(first.config);
      expect(updated.configRoot).toBe(f.options.home);
      expect(updated.client).toBe('windsurf');
      if (layout === 'documented')
        expect(await f.readConfig(ide)).toEqual({ mcpServers: {}, owner: 'new-ide-config' });
      await removeMcp('demo', f.clientOptions);
      expect(await f.readConfig(first.config)).toEqual({ mcpServers: {} });
    },
  );

  it.each(['claude-desktop', 'windsurf', 'cursor'] as const)(
    'retains the user boundary for an older %s record',
    async (client) => {
      const f = await fixture();
      vi.stubEnv('HOME', f.options.home);
      vi.stubEnv('USERPROFILE', f.options.home);
      const appData = join(f.options.home, 'roaming');
      vi.stubEnv('APPDATA', appData);
      const first = await addMcp(f.dir, { ...f.clientOptions, client, user: true });
      const lock = await readPassports(f.options.stroqHome);
      const { configRoot: _root, ...record } = first;
      await writePassports(f.options.stroqHome, { ...lock, mcp: { ...lock.mcp, demo: record } });
      const updated = await addMcp('demo', f.clientOptions);
      expect(updated.client).toBe(client);
      expect(updated.configRoot).toBe(
        client === 'claude-desktop' && process.platform === 'win32' ? appData : f.options.home,
      );
      await removeMcp('demo', f.clientOptions);
      expect(await f.readConfig(first.config)).toEqual({ mcpServers: {} });
    },
  );

  it.runIf(process.platform === 'win32')(
    'uses redirected Windows application data as its user boundary',
    async () => {
      const f = await fixture();
      vi.stubEnv('HOME', f.options.home);
      vi.stubEnv('USERPROFILE', f.options.home);
      const appData = join(f.root, 'redirected-roaming');
      vi.stubEnv('APPDATA', appData);
      const record = await addMcp(f.dir, { ...f.clientOptions, client: 'claude-desktop' });
      expect(record.configRoot).toBe(appData);
      expect(record.config).toBe(join(appData, 'Claude', 'claude_desktop_config.json'));
      await removeMcp('demo', f.clientOptions);
    },
  );

  it.each([false, true])(
    'preserves client, cwd and target when updated from another project (legacy=%s)',
    async (legacy) => {
      const f = await fixture();
      const first = await addMcp(f.dir, { ...f.clientOptions, client: 'claude-code' });
      if (legacy) {
        const lock = await readPassports(f.options.stroqHome);
        const { cwd: _cwd, configRoot: _root, ...record } = first;
        await writePassports(f.options.stroqHome, { ...lock, mcp: { ...lock.mcp, demo: record } });
      }
      const otherProject = join(f.root, 'other-project');
      await mkdir(otherProject);
      await writeFile(join(f.dir, 'server.js'), 'console.log("two");\n');
      const updated = await addMcp('demo', { ...f.clientOptions, project: otherProject });
      expect(invocation(updated)).toMatchObject({ client: 'claude-code', cwd: f.options.project });
      expect(updated.config).toBe(first.config);
      expect(updated.configRoot).toBe(f.options.project);
      await expect(readFile(join(otherProject, '.mcp.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('preserves an explicit cwd until an update explicitly replaces it', async () => {
    const f = await fixture();
    const cwd = join(f.root, 'engine-project');
    const changedCwd = join(f.root, 'new-engine-project');
    await mkdir(cwd);
    await mkdir(changedCwd);
    const first = await addMcp(f.dir, { ...f.mcpOptions, cwd });
    const unchanged = await addMcp('demo', f.clientOptions);
    expect(invocation(unchanged)).toMatchObject({ client: first.client, cwd });
    expect(unchanged.history.at(-1)?.material).toBe(false);
    const changed = await addMcp('demo', { ...f.clientOptions, cwd: changedCwd });
    expect(invocation(changed).cwd).toBe(changedCwd);
    expect(changed.history.at(-1)?.material).toBe(true);
    const restored = await addMcp('demo', { ...f.clientOptions, restore: true });
    expect(invocation(restored).cwd).toBe(changedCwd);
  });
});

describe.skipIf(process.platform === 'win32')('MCP automatic config boundaries', () => {
  it('refuses a project client directory linked outside the project before confirmation', async () => {
    const f = await fixture();
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    const config = join(outside, 'mcp.json');
    const before = '{"mcpServers":{},"owner":"external"}';
    await writeFile(config, before);
    await symlink(outside, join(f.options.project, '.cursor'));
    await expect(addMcp(f.dir, { ...f.clientOptions, client: 'cursor' })).rejects.toThrow(
      /outside/,
    );
    expect(f.prompts()).toBe(0);
    expect(await readFile(config, 'utf8')).toBe(before);
    await expect(readFile(join(f.options.stroqHome, 'passports.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses a user client directory linked outside the home', async () => {
    const f = await fixture();
    vi.stubEnv('HOME', f.options.home);
    vi.stubEnv('USERPROFILE', f.options.home);
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(f.options.home, '.cursor'));
    await expect(
      addMcp(f.dir, { ...f.clientOptions, client: 'cursor', user: true }),
    ).rejects.toThrow(/outside/);
    await expect(readFile(join(outside, 'mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows a linked home root and a user config linked elsewhere inside that home', async () => {
    const f = await fixture();
    const home = join(f.root, 'home-link');
    await symlink(f.options.home, home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const config = join(f.options.home, 'dotfiles', 'mcp.json');
    await mkdir(join(f.options.home, 'dotfiles'));
    await mkdir(join(f.options.home, '.cursor'));
    await writeFile(config, JSON.stringify({ mcpServers: {}, owner: 'dotfiles' }));
    const link = join(f.options.home, '.cursor', 'mcp.json');
    await symlink(config, link);
    const first = await addMcp(f.dir, { ...f.clientOptions, client: 'cursor', user: true });
    expect(first.configRoot).toBe(home);
    expect((await f.readConfig(config)).mcpServers.demo).toEqual(first.written);
    await addMcp('demo', f.clientOptions);
    await removeMcp('demo', f.clientOptions);
    expect(await f.readConfig(config)).toEqual({ mcpServers: {}, owner: 'dotfiles' });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  it.each([false, true])(
    'keeps the original project boundary on updates and removal from another project (legacy=%s)',
    async (legacy) => {
      const f = await fixture();
      const first = await addMcp(f.dir, { ...f.clientOptions, client: 'cursor' });
      if (legacy) {
        const lock = await readPassports(f.options.stroqHome);
        const { configRoot: _root, ...record } = first;
        await writePassports(f.options.stroqHome, { ...lock, mcp: { ...lock.mcp, demo: record } });
      }
      const outside = join(f.root, 'outside');
      await mkdir(outside);
      const before = await readFile(first.config, 'utf8');
      await writeFile(join(outside, 'mcp.json'), before);
      await rm(join(f.options.project, '.cursor'), { recursive: true });
      await symlink(outside, join(f.options.project, '.cursor'));
      const options = { ...f.clientOptions, project: outside, force: true };
      const lockBefore = await readFile(join(f.options.stroqHome, 'passports.json'), 'utf8');
      await expect(addMcp('demo', options)).rejects.toThrow(/outside/);
      await expect(removeMcp('demo', options)).rejects.toThrow(/outside/);
      expect(await readFile(join(outside, 'mcp.json'), 'utf8')).toBe(before);
      expect(await readFile(join(f.options.stroqHome, 'passports.json'), 'utf8')).toBe(lockBefore);
    },
  );

  it('rechecks the project boundary after storage work', async () => {
    const f = await fixture();
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    await mkdir(join(f.options.project, '.cursor'));
    const before = '{"mcpServers":{},"owner":"external"}';
    await writeFile(join(outside, 'mcp.json'), before);
    const actual = store.putStore;
    vi.spyOn(store, 'putStore').mockImplementation(async (...args) => {
      await rm(join(f.options.project, '.cursor'), { recursive: true });
      await symlink(outside, join(f.options.project, '.cursor'));
      return actual(...args);
    });
    await expect(addMcp(f.dir, { ...f.clientOptions, client: 'cursor' })).rejects.toThrow(
      /outside/,
    );
    expect(await readFile(join(outside, 'mcp.json'), 'utf8')).toBe(before);
  });

  it.each(['file', 'directory'])(
    'allows an explicit config reached through a %s link outside the project',
    async (kind) => {
      const f = await fixture();
      const outside = join(f.root, 'outside');
      await mkdir(outside);
      const realConfig = join(outside, 'mcp.json');
      await writeFile(realConfig, JSON.stringify({ mcpServers: {}, owner: 'explicit' }));
      const link = join(f.options.project, kind === 'file' ? 'custom.json' : '.cursor');
      await symlink(kind === 'file' ? realConfig : outside, link);
      const config = kind === 'file' ? link : join(link, 'mcp.json');
      const record = await addMcp(f.dir, { ...f.clientOptions, config });
      expect(record.configRoot).toBeNull();
      await addMcp('demo', f.clientOptions);
      await removeMcp('demo', f.clientOptions);
      expect(await f.readConfig(realConfig)).toEqual({ mcpServers: {}, owner: 'explicit' });
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
    },
  );
});

describe('MCP config edits remain owned by the client', () => {
  it.each([{ entry: null }, { entry: 17 }, { entry: ['owner-data'] }, { entry: 'owner-data' }])(
    'refuses a preexisting server entry of any shape ($entry)',
    async ({ entry }) => {
      const f = await fixture();
      const before = JSON.stringify({ mcpServers: { demo: entry } });
      await writeFile(f.config, before);
      await expect(addMcp(f.dir, f.mcpOptions)).rejects.toThrow(/already has/);
      expect(await readFile(f.config, 'utf8')).toBe(before);
      expect(f.prompts()).toBe(0);
    },
  );

  it.each(['add', 'update', 'restore'] as const)(
    'merges unrelated config edits during %s storage work',
    async (action) => {
      const f = await fixture();
      if (action !== 'add') await addMcp(f.dir, f.mcpOptions);
      if (action === 'update') await writeFile(join(f.dir, 'server.js'), 'console.log("two");\n');
      const actual = store.putStore;
      vi.spyOn(store, 'putStore').mockImplementation(async (...args) => {
        const config = await f.readConfig();
        config.owner = 'concurrent-edit';
        config.mcpServers.other = { command: 'foreign' };
        await writeFile(f.config, JSON.stringify(config));
        return actual(...args);
      });
      const record = await addMcp(action === 'add' ? f.dir : 'demo', {
        ...f.mcpOptions,
        restore: action === 'restore',
      });
      expect(await f.readConfig()).toMatchObject({
        owner: 'concurrent-edit',
        mcpServers: { demo: record.written, other: { command: 'foreign' } },
      });
      expect(record.history.at(-1)?.action).toBe(action);
    },
  );

  it('merges unrelated edits made while the removal is being confirmed', async () => {
    const f = await fixture();
    await addMcp(f.dir, f.mcpOptions);
    const ask = f.terminal.readLine;
    await removeMcp('demo', {
      ...f.mcpOptions,
      terminal: {
        ...f.terminal,
        readLine: async (prompt) => {
          const config = await f.readConfig();
          config.owner = 'concurrent-edit';
          config.mcpServers.other = { command: 'foreign' };
          await writeFile(f.config, JSON.stringify(config));
          return ask(prompt);
        },
      },
    });
    expect(await f.readConfig()).toEqual({
      owner: 'concurrent-edit',
      mcpServers: { other: { command: 'foreign' } },
    });
  });

  it.each(['add', 'update'] as const)(
    'keeps an outside edit of its own entry during %s storage work',
    async (action) => {
      const f = await fixture();
      if (action === 'update') await addMcp(f.dir, f.mcpOptions);
      const initial = await readPassports(f.options.stroqHome);
      const actual = store.putStore;
      vi.spyOn(store, 'putStore').mockImplementation(async (...args) => {
        const config = await f.readConfig();
        config.mcpServers.demo = null;
        await writeFile(f.config, JSON.stringify(config));
        return actual(...args);
      });
      await expect(addMcp(action === 'add' ? f.dir : 'demo', f.mcpOptions)).rejects.toThrow(
        /changed while confirming/,
      );
      expect((await f.readConfig()).mcpServers.demo).toBeNull();
      expect(await readPassports(f.options.stroqHome)).toEqual(initial);
    },
  );

  it.each([true, false])(
    'refuses a replacement derived from stale config bytes before saving the lock (exists=%s)',
    async (exists) => {
      const f = await fixture();
      const before = exists ? await readFile(f.config, 'utf8') : null;
      if (!exists) await rm(f.config);
      const changed = '{ "mcpServers": {}, "owner": "concurrent-edit" }\n';
      await writeFile(f.config, changed);
      const save = vi.fn(async () => undefined);
      await expect(
        commitMcpConfig(f.config, { mcpServers: { demo: {} } }, save, { before }),
      ).rejects.toThrow(/changed before writing/);
      expect(save).not.toHaveBeenCalled();
      expect(await readFile(f.config, 'utf8')).toBe(changed);
    },
  );
});
