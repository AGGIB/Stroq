import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as transaction from '../../src/install/mcp-config-transaction.js';
import { runRemove } from '../../src/commands/remove.js';
import * as terminal from '../../src/ui/terminal.js';
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
      previousRecord: initial,
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

async function interrupt(f: Awaited<ReturnType<typeof fixture>>, source = 'demo', force = false) {
  let pending: Awaited<ReturnType<typeof readPassports>>;
  vi.spyOn(transaction, 'commitMcpConfig').mockImplementationOnce(async (file, config) => {
    await writeFile(file, JSON.stringify(config));
    pending = await readPassports(f.options.stroqHome);
    throw new Error('simulated interruption');
  });
  await expect(addMcp(source, { ...f.mcpOptions, force })).rejects.toThrow(
    'simulated interruption',
  );
  // A process kill cannot run addMcp's catch. Restore the exact pending snapshot from that point.
  await writePassports(f.options.stroqHome, pending!);
}

describe('MCP recovery keeps confirmation and target identity', () => {
  it('can cancel a first install even after an interrupted retry', async () => {
    const f = await fixture();
    await interrupt(f, f.dir);
    await interrupt(f, 'demo', true);
    await removeMcp('demo', { ...f.mcpOptions, force: true });
    expect((await f.servers())['demo']).toBeUndefined();
    expect((await readPassports(f.options.stroqHome)).mcp?.['demo']).toBeUndefined();
  });
  it.each([false, true])(
    'restores a usable confirmation after cancelling an update (same digest: %s)',
    async (same) => {
      const f = await fixture();
      const previous = await addMcp(f.dir, f.mcpOptions);
      if (!same) await writeFile(join(f.dir, 'server.js'), 'console.log("two");\n');
      await interrupt(f);
      await removeMcp('demo', { ...f.mcpOptions, force: true });
      expect((await f.servers())['demo']).toEqual(previous.written);
      expect((await readPassports(f.options.stroqHome)).mcp?.['demo']).toEqual(previous);
      const launch = await preparePin({
        server: 'demo',
        pin: previous.grant.pin,
        home: f.options.stroqHome,
        command: process.execPath,
        args: [join(storePath(f.options.stroqHome, previous.digest), 'tree', 'server.js')],
        passEnv: previous.passEnv,
        launch: {
          command: previous.written['command'] as string,
          argv: previous.written['args'] as string[],
        },
      });
      await launch.cleanup();
    },
  );

  it('retries a pending first install by name without source or target flags', async () => {
    const f = await fixture();
    await interrupt(f, f.dir);
    const { config: _config, ...options } = f.mcpOptions;
    const recovered = await addMcp('demo', { ...options, force: true });
    expect(recovered.config).toBe(f.config);
    expect(recovered.source).toBe(f.dir);
    expect(recovered.status).toBe('confirmed');
  });

  it('refuses a pending retry into another config and keeps both files and lock intact', async () => {
    const f = await fixture();
    await interrupt(f, f.dir);
    const other = join(f.root, 'other-client.json');
    const text = JSON.stringify({ mcpServers: { demo: { command: 'unrelated' } } });
    await writeFile(other, text);
    const before = await readFile(f.config, 'utf8');
    const lock = await readPassports(f.options.stroqHome);
    await expect(addMcp(f.dir, { ...f.mcpOptions, config: other, force: true })).rejects.toThrow(
      /another client config/,
    );
    expect(await readFile(other, 'utf8')).toBe(text);
    expect(await readFile(f.config, 'utf8')).toBe(before);
    expect(await readPassports(f.options.stroqHome)).toEqual(lock);
  });

  it('removes a no-record orphan through the CLI with an explicit config', async () => {
    const f = await fixture();
    await addMcp(f.dir, f.mcpOptions);
    await writePassports(f.options.stroqHome, { v: 1, skills: {}, mcp: {} });
    vi.stubEnv('STROQ_HOME', f.options.stroqHome);
    vi.spyOn(terminal, 'currentTerminal').mockReturnValue(f.terminal);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await runRemove(['demo', '--kind', 'mcp', '--force', '--config', f.config])).toBe(0);
    expect((await f.servers())['demo']).toBeUndefined();
    expect((await f.servers())['other']).toEqual({ command: 'keep', args: ['1'] });
  });
});
