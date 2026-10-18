import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addMcp, removeMcp } from '../../src/install/mcp-install.js';
import { readPassports, withPassports, writePassports } from '../../src/install/lock.js';
import { storePath } from '../../src/install/store.js';
import { preparePin } from '../../src/mcp/pin.js';
import { setup } from '../helpers/skill-install.js';
import { entryFor } from '../../src/install/mcp-client-config.js';
import type { McpPendingRecord } from '../../src/install/mcp-record.js';

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
    JSON.stringify({
      mcpServers: {
        other: { command: 'keep', args: ['1'] },
      },
      extra: true,
    }),
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

describe('MCP install crash recovery', () => {
  it('recovers from interrupted first install: remove --kind mcp --force removes wrapper and keeps other servers', async () => {
    const f = await fixture();
    const installed = await addMcp(f.dir, f.mcpOptions);
    const writtenWrapper = installed.written;
    const digest = installed.digest;

    // Simulate crash between config write and lock finalization for first install:
    const pendingRecord: McpPendingRecord = {
      kind: 'mcp',
      status: 'pending',
      digest,
      grant: { pin: `sha256:${digest}` },
      source: f.dir,
      config: f.config,
      configRoot: null,
      client: 'client.json',
      cwd: f.options.project,
      entrypoint: 'server.js',
      passEnv: [],
      passport: installed.passport,
      written: writtenWrapper,
      original: null,
      replaced: undefined,
      history: [],
    };

    await withPassports(f.options.stroqHome, async (lock) => {
      await writePassports(f.options.stroqHome, {
        ...lock,
        mcp: { ...(lock.mcp ?? {}), demo: pendingRecord },
      });
    });

    // Pin fails closed because pending status is not confirmed
    await expect(
      preparePin({
        server: 'demo',
        pin: `sha256:${digest}`,
        command: process.execPath,
        args: [join(storePath(f.options.stroqHome, digest), 'tree', 'server.js')],
        home: f.options.stroqHome,
      }),
    ).rejects.toThrow(/this server and digest are not confirmed on this machine/);

    // add without --force refuses
    await expect(addMcp(f.dir, f.mcpOptions)).rejects.toThrow(/already has a server by this name/);

    // remove with --force removes wrapper, keeps other servers, and clears pending lock
    await removeMcp('demo', { ...f.mcpOptions, force: true });

    const servers = await f.servers();
    expect(servers['demo']).toBeUndefined();
    expect(servers['other']).toEqual({ command: 'keep', args: ['1'] });

    const lockAfter = await readPassports(f.options.stroqHome);
    expect(lockAfter.mcp?.['demo']).toBeUndefined();
  });

  it('recovers from interrupted update: remove --kind mcp --force restores replaced server', async () => {
    const f = await fixture();
    const initial = await addMcp(f.dir, f.mcpOptions);
    const originalWrapper = initial.written;

    // Simulate an update that crashed: client config has a new wrapper, lock has pending with replaced
    const newWrapper = entryFor(
      'demo',
      {
        digest: '1111111111111111111111111111111111111111111111111111111111111111',
        entrypoint: 'server.js',
        passEnv: [],
      },
      f.mcpOptions,
      'client.json',
      f.options.project,
      null,
    );

    await writeFile(
      f.config,
      JSON.stringify({
        mcpServers: {
          demo: newWrapper,
          other: { command: 'keep', args: ['1'] },
        },
      }),
    );

    const pendingRecord: McpPendingRecord = {
      kind: 'mcp',
      status: 'pending',
      digest: '1111111111111111111111111111111111111111111111111111111111111111',
      grant: { pin: 'sha256:1111111111111111111111111111111111111111111111111111111111111111' },
      source: f.dir,
      config: f.config,
      configRoot: null,
      client: 'client.json',
      cwd: f.options.project,
      entrypoint: 'server.js',
      passEnv: [],
      passport: initial.passport,
      written: newWrapper,
      original: null,
      replaced: originalWrapper,
      history: initial.history,
    };

    await withPassports(f.options.stroqHome, async (lock) => {
      await writePassports(f.options.stroqHome, {
        ...lock,
        mcp: { ...(lock.mcp ?? {}), demo: pendingRecord },
      });
    });

    // remove with --force restores the replaced wrapper
    await removeMcp('demo', { ...f.mcpOptions, force: true });

    const servers = await f.servers();
    expect(servers['demo']).toEqual(originalWrapper);
    expect(servers['other']).toEqual({ command: 'keep', args: ['1'] });
  });

  it('recovers from orphan wrapper with no lock record via remove --kind mcp --force', async () => {
    const f = await fixture();
    const orphanWrapper = entryFor(
      'demo',
      {
        digest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        entrypoint: 'server.js',
        passEnv: [],
      },
      f.mcpOptions,
      'client.json',
      f.options.project,
      null,
    );

    await writeFile(
      f.config,
      JSON.stringify({
        mcpServers: {
          demo: orphanWrapper,
          other: { command: 'keep', args: ['1'] },
        },
      }),
    );

    // remove without --force fails
    await expect(removeMcp('demo', f.mcpOptions)).rejects.toThrow(/not installed/);

    // remove with --force removes orphan wrapper
    await removeMcp('demo', { ...f.mcpOptions, force: true });

    const servers = await f.servers();
    expect(servers['demo']).toBeUndefined();
    expect(servers['other']).toEqual({ command: 'keep', args: ['1'] });
  });

  it('allows add --force over a pending or orphan wrapper', async () => {
    const f = await fixture();
    const orphanWrapper = entryFor(
      'demo',
      {
        digest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        entrypoint: 'server.js',
        passEnv: [],
      },
      f.mcpOptions,
      'client.json',
      f.options.project,
      null,
    );

    await writeFile(
      f.config,
      JSON.stringify({
        mcpServers: {
          demo: orphanWrapper,
          other: { command: 'keep', args: ['1'] },
        },
      }),
    );

    // add with --force succeeds
    const record = await addMcp(f.dir, { ...f.mcpOptions, force: true });
    expect(record.status).toBe('confirmed');

    const servers = await f.servers();
    expect(servers['demo'].args).toContain(`sha256:${record.digest}`);
    expect(servers['other']).toEqual({ command: 'keep', args: ['1'] });
  });
});
