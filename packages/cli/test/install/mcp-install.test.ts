import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addMcp, entrypointOf, removeMcp } from '../../src/install/mcp-install.js';
import { addSkill } from '../../src/install/skill-install.js';
import { readPassports } from '../../src/install/lock.js';
import { storePath } from '../../src/install/store.js';
import { parseMcpArgv } from '../../src/commands/mcp.js';
import { preparePin } from '../../src/mcp/pin.js';
import { setup } from '../helpers/skill-install.js';
import { tgzOf } from '../helpers/tar-writer.js';
import { commitMcpConfig } from '../../src/install/mcp-config-transaction.js';

async function server(root: string, code = 'console.log("one");\n') {
  const dir = join(root, 'srv');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0', bin: { demo: 'server.js' } }),
  );
  await writeFile(join(dir, 'server.js'), code);
  return dir;
}

async function fixture() {
  const f = await setup();
  const dir = await server(f.root);
  const config = join(f.root, 'client.json');
  await writeFile(
    config,
    JSON.stringify({ mcpServers: { other: { command: 'keep', args: ['1'] } }, extra: true }),
  );
  const options = {
    project: f.options.project,
    stroqHome: f.options.stroqHome,
    terminal: f.terminal,
    node: process.execPath,
    entryArgv: ['/stroq/dist/index.js'],
    config,
  };
  const servers = async () =>
    (JSON.parse(await readFile(config, 'utf8')) as { mcpServers: Record<string, any> }).mcpServers;
  return { ...f, dir, config, mcpOptions: options, servers };
}

describe('confirmed MCP install', () => {
  it('adds a server by digest, writes a pinned wrapper and a lock record the proxy accepts', async () => {
    const f = await fixture();
    const record = await addMcp(f.dir, { ...f.mcpOptions, passEnv: ['API_KEY'] });
    expect(f.prompts()).toBe(1);
    const servers = await f.servers();
    expect(servers['other']).toEqual({ command: 'keep', args: ['1'] });
    const args = servers['demo'].args as string[];
    const parsed = parseMcpArgv(args.slice(args.indexOf('mcp') + 1));
    expect(parsed).toMatchObject({ ok: true });
    expect(args).toContain(`sha256:${record.digest}`);
    expect(args[args.indexOf('--pass-env') + 1]).toBe('API_KEY');
    const lock = await readPassports(f.options.stroqHome);
    expect(lock.mcp?.['demo']).toMatchObject({
      kind: 'mcp',
      status: 'confirmed',
      digest: record.digest,
    });
    const pinned = await preparePin({
      home: f.options.stroqHome,
      server: 'demo',
      pin: `sha256:${record.digest}`,
      command: 'node',
      args: [join(storePath(f.options.stroqHome, record.digest), 'tree', 'server.js')],
      // What the proxy knows of how it was started: the wrapper is held to the entry that add wrote.
      passEnv: ['API_KEY'],
      launch: { command: servers['demo'].command as string, argv: args },
    });
    await pinned.cleanup();
  });

  it('refuses scripts and an unconfirmed prompt without touching config or lock', async () => {
    const f = await fixture();
    const before = await readFile(f.config, 'utf8');
    await expect(
      addMcp(f.dir, { ...f.mcpOptions, terminal: { ...f.terminal, interactive: false } }),
    ).rejects.toThrow(/terminal/);
    await expect(
      addMcp(f.dir, { ...f.mcpOptions, terminal: { ...f.terminal, readLine: async () => null } }),
    ).rejects.toThrow(/confirm/);
    expect(await readFile(f.config, 'utf8')).toBe(before);
    await expect(readFile(join(f.options.stroqHome, 'passports.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses an existing server of the same name that Stroq did not write', async () => {
    const f = await fixture();
    await writeFile(f.config, JSON.stringify({ mcpServers: { demo: { command: 'mine' } } }));
    await expect(addMcp(f.dir, f.mcpOptions)).rejects.toThrow(/already has/);
  });

  it('updates a changed server with a typed digest and drops the old revision', async () => {
    const f = await fixture();
    const first = await addMcp(f.dir, f.mcpOptions);
    await writeFile(join(f.dir, 'server.js'), 'console.log("two");\n');
    const second = await addMcp('demo', f.mcpOptions);
    expect(second.digest).not.toBe(first.digest);
    expect(second.history.map((h) => h.action)).toEqual(['add', 'update']);
    await expect(
      readFile(join(storePath(f.options.stroqHome, first.digest), 'manifest.json')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      await readFile(
        join(storePath(f.options.stroqHome, second.digest), 'tree', 'server.js'),
        'utf8',
      ),
    ).toBe('console.log("two");\n');
  });

  it('refuses to update over an outside edit of the config entry unless forced', async () => {
    const f = await fixture();
    await addMcp(f.dir, f.mcpOptions);
    const servers = await f.servers();
    servers['demo'].env = { SNEAKY: '1' };
    await writeFile(f.config, JSON.stringify({ mcpServers: servers }));
    await writeFile(join(f.dir, 'server.js'), 'console.log("two");\n');
    await expect(addMcp('demo', f.mcpOptions)).rejects.toThrow(/outside Stroq/);
    await expect(addMcp('demo', { ...f.mcpOptions, force: true })).resolves.toMatchObject({
      status: 'confirmed',
    });
  });

  it('restores the config on removal, and keeps outside edits without --force', async () => {
    const f = await fixture();
    const record = await addMcp(f.dir, f.mcpOptions);
    await removeMcp('demo', f.mcpOptions);
    expect((await f.servers())['demo']).toBeUndefined();
    expect((await f.servers())['other']).toEqual({ command: 'keep', args: ['1'] });
    expect((await readPassports(f.options.stroqHome)).mcp?.['demo']).toMatchObject({
      status: 'revoked',
      history: [
        expect.objectContaining({ action: 'add' }),
        expect.objectContaining({ action: 'remove', to: null, confirmed: true }),
      ],
    });
    await expect(
      readFile(join(storePath(f.options.stroqHome, record.digest), 'manifest.json')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await addMcp(f.dir, f.mcpOptions);
    const servers = await f.servers();
    servers['demo'].command = 'evil';
    await writeFile(f.config, JSON.stringify({ mcpServers: servers }));
    await expect(removeMcp('demo', f.mcpOptions)).rejects.toThrow(/outside Stroq/);
    await removeMcp('demo', { ...f.mcpOptions, force: true });
    expect((await f.servers())['demo']).toBeUndefined();
  });

  it('coexists with a skill of the same name and keeps its lock record on removal', async () => {
    const f = await fixture();
    await addSkill(f.source, f.options);
    await addMcp(f.dir, f.mcpOptions);
    await removeMcp('demo', f.mcpOptions);
    expect((await readPassports(f.options.stroqHome)).skills['demo']?.status).toBe('confirmed');
  });

  it('keeps its pin when a skill is added afterwards', async () => {
    const f = await fixture();
    const record = await addMcp(f.dir, f.mcpOptions);
    await addSkill(f.source, f.options);
    expect((await readPassports(f.options.stroqHome)).mcp?.['demo']).toMatchObject({
      digest: record.digest,
    });
  });

  it('finds the entrypoint safely', async () => {
    const f = await fixture();
    const { readDirTree } = await import('../../src/install/read-dir.js');
    const { tree } = await readDirTree(f.dir);
    expect(entrypointOf(tree, undefined)).toBe('server.js');
    expect(() => entrypointOf(tree, '../x.js')).toThrow(/inside/);
    expect(() => entrypointOf(tree, 'package.json')).toThrow(/node server/);
    expect(() => entrypointOf(tree, 'missing.js')).toThrow(/not a file/);
  });

  it('creates an absent client config only after confirmation', async () => {
    const f = await fixture();
    await unlink(f.config);
    await expect(
      addMcp(f.dir, { ...f.mcpOptions, terminal: { ...f.terminal, readLine: async () => null } }),
    ).rejects.toThrow(/confirm/);
    await expect(readFile(f.config)).rejects.toMatchObject({ code: 'ENOENT' });
    await addMcp(f.dir, f.mcpOptions);
    expect((await f.servers())['demo'].command).toBe(process.execPath);
  });

  it('installs an archive without running its scripts', async () => {
    const f = await fixture();
    const archive = join(f.root, 'server.tgz');
    await writeFile(
      archive,
      tgzOf([
        {
          name: 'package/package.json',
          data: JSON.stringify({
            name: 'demo',
            main: 'server.js',
            scripts: { install: 'must-not-run' },
          }),
        },
        { name: 'package/server.js', data: 'throw new Error("must not run during add");' },
      ]),
    );
    const record = await addMcp(archive, f.mcpOptions);
    expect(record.passport.artifact.source.type).toBe('tarball');
    expect(
      await readFile(
        join(storePath(f.options.stroqHome, record.digest), 'tree', 'server.js'),
        'utf8',
      ),
    ).toContain('must not run');
  });

  it('restores the confirmed wrapper without rereading a removed source', async () => {
    const f = await fixture();
    const first = await addMcp(f.dir, f.mcpOptions);
    const servers = await f.servers();
    servers['demo'].command = 'outside-edit';
    await writeFile(f.config, JSON.stringify({ mcpServers: servers }));
    await unlink(join(f.dir, 'package.json'));
    const restored = await addMcp('demo', { ...f.mcpOptions, restore: true, force: true });
    expect(restored.digest).toBe(first.digest);
    expect(restored.history.at(-1)).toMatchObject({
      action: 'restore',
      material: true,
      confirmed: true,
    });
    expect((await f.servers())['demo']).toEqual(first.written);
  });

  it('reports stored content drift before update or removal', async () => {
    const f = await fixture();
    const first = await addMcp(f.dir, f.mcpOptions);
    const config = await readFile(f.config, 'utf8');
    const lock = await readFile(join(f.options.stroqHome, 'passports.json'), 'utf8');
    await writeFile(
      join(storePath(f.options.stroqHome, first.digest), 'tree', 'server.js'),
      'tampered',
    );
    await expect(addMcp('demo', f.mcpOptions)).rejects.toThrow(/changed|bytes/);
    await expect(removeMcp('demo', { ...f.mcpOptions, force: true })).rejects.toThrow(
      /changed|bytes/,
    );
    expect(await readFile(f.config, 'utf8')).toBe(config);
    expect(await readFile(join(f.options.stroqHome, 'passports.json'), 'utf8')).toBe(lock);
  });

  it.each([true, false])(
    'rolls back exact config bytes or absence on lock failure (exists=%s)',
    async (exists) => {
      const f = await fixture();
      const raw = '{  "mcpServers": {} , "owner": 1 }\n';
      if (exists) await writeFile(f.config, raw);
      else await unlink(f.config);
      await expect(
        commitMcpConfig(f.config, { mcpServers: { demo: {} } }, async () => {
          throw new Error('lock failure');
        }),
      ).rejects.toThrow('lock failure');
      if (exists) expect(await readFile(f.config, 'utf8')).toBe(raw);
      else await expect(readFile(f.config)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('keeps an owner edit made while a failed lock write is in progress', async () => {
    const f = await fixture();
    await expect(
      commitMcpConfig(f.config, {}, async () => {
        await writeFile(f.config, '{"owner":"changed"}');
        throw new Error('lock failure');
      }),
    ).rejects.toThrow(/outside config edit was preserved/);
    expect(await readFile(f.config, 'utf8')).toBe('{"owner":"changed"}');
  });
});
