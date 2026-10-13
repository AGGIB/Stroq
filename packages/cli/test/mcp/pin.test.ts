import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTree, fileDigestOf, treeDigest } from '../../src/install/tree.js';
import { preparePin, inspectPin } from '../../src/mcp/pin.js';
import { parseMcpArgv } from '../../src/commands/mcp.js';
import { wrapMcpConfig } from '../../src/commands/mcp-config.js';
import { configPinStatus } from '../../src/mcp/pin-status.js';
import { runMcpProxy } from '../../src/mcp/proxy.js';
import { createEngine } from '../../src/engine-factory.js';
import { PassThrough } from 'node:stream';
import { doctorReport } from '../../src/commands/doctor.js';
import { buildExposureReport } from '../../src/commands/exposure.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.length = 0;
});

async function fixture(exec = false, code = 'console.log("checked");\n') {
  const home = await mkdtemp(join(tmpdir(), 'stroq-pin-test-'));
  roots.push(home);
  const bytes = Buffer.from(code);
  const tree = buildTree([
    {
      path: 'server.mjs',
      kind: 'file',
      exec,
      size: bytes.length,
      sha256: fileDigestOf(bytes),
      bytes,
    },
  ]);
  const digest = treeDigest(tree);
  const store = join(home, 'store', `sha256-${digest.slice(0, 32)}`);
  await mkdir(join(store, 'tree'), { recursive: true });
  await writeFile(join(store, 'tree', 'server.mjs'), bytes, { mode: 0o600 });
  await writeFile(
    join(store, 'manifest.json'),
    JSON.stringify({ entries: tree.entries.map(({ bytes: _bytes, ...entry }) => entry) }),
  );
  const record = { kind: 'mcp', status: 'confirmed', digest, grant: { pin: `sha256:${digest}` } };
  await writeFile(
    join(home, 'passports.json'),
    JSON.stringify({ v: 1, skills: {}, mcp: { demo: record } }),
  );
  const options = {
    home,
    server: 'demo',
    pin: `sha256:${digest}`,
    command: process.execPath,
    args: [join(store, 'tree', 'server.mjs'), '--data'],
  };
  return { home, bytes, digest, store, options, record };
}

describe('runtime pin', () => {
  it('runs an isolated copy of the exact confirmed bytes, restoring manifest execute metadata', async () => {
    const f = await fixture(true);
    const copy = await preparePin(f.options);
    try {
      expect(copy.command).toBe(process.execPath);
      expect(copy.args[0]).not.toBe(f.options.args[0]);
      expect(copy.args[1]).toBe('--data');
      await writeFile(f.options.args[0]!, 'changed after verification');
      expect(await readFile(copy.args[0]!)).toEqual(f.bytes);
      expect(copy.cwd).not.toBe(join(f.store, 'tree'));
    } finally {
      await copy.cleanup();
    }
    await expect(readFile(copy.args[0]!)).rejects.toThrow();
  });

  it('refuses drift, including an extra unmanifested file', async () => {
    const f = await fixture();
    await writeFile(join(f.store, 'tree', 'extra.js'), 'extra');
    await expect(preparePin(f.options)).rejects.toThrow(/changed|digest/);
    expect(await inspectPin(f.options)).toMatchObject({ ok: false });
  });

  it('refuses changed file bytes and missing manifests', async () => {
    const f = await fixture();
    await writeFile(f.options.args[0]!, 'changed');
    await expect(preparePin(f.options)).rejects.toThrow(/changed|digest/);
    await rm(join(f.store, 'manifest.json'));
    expect(await inspectPin(f.options)).toMatchObject({ ok: false });
  });

  it.each(['drifted', 'revoked'])('refuses %s confirmations', async (status) => {
    const f = await fixture();
    await writeFile(
      join(f.home, 'passports.json'),
      JSON.stringify({ v: 1, mcp: { demo: { ...f.record, status } } }),
    );
    await expect(preparePin(f.options)).rejects.toThrow(/confirmed/);
  });

  it('refuses a missing, mismatched or invalid local confirmation', async () => {
    const f = await fixture();
    for (const lock of [
      { v: 1, mcp: {} },
      { v: 1, mcp: { demo: { ...f.record, grant: { pin: `sha256:${'0'.repeat(64)}` } } } },
      { v: 2, mcp: { demo: f.record } },
    ]) {
      await writeFile(join(f.home, 'passports.json'), JSON.stringify(lock));
      await expect(preparePin(f.options)).rejects.toThrow(/confirmed|lock/);
    }
  });

  it('accepts only a node entrypoint inside the pinned tree', async () => {
    const f = await fixture();
    await expect(preparePin({ ...f.options, command: 'npx' })).rejects.toThrow(/node/);
    for (const args of [
      [],
      ['--eval', 'evil'],
      [join(f.home, 'outside.mjs')],
      [join(f.store, 'tree', 'missing.mjs')],
    ]) {
      await expect(preparePin({ ...f.options, args })).rejects.toThrow(/entrypoint/);
    }
  });

  it('refuses excluded node_modules instead of silently hashing a partial tree', async () => {
    const f = await fixture();
    await mkdir(join(f.store, 'tree', 'node_modules'));
    await expect(preparePin(f.options)).rejects.toThrow(/verify/);
  });

  it('reports an intact pin without making a runtime copy', async () => {
    const f = await fixture();
    expect(await inspectPin(f.options)).toEqual({
      ok: true,
      detail: 'confirmed bytes intact (tamper-evident, not tamper-proof)',
    });
  });

  it('refuses linked tree folders', async () => {
    const f = await fixture();
    await rm(join(f.store, 'tree'), { recursive: true });
    await symlink(f.home, join(f.store, 'tree'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(preparePin(f.options)).rejects.toThrow(/linked/);
  });

  it('refuses invalid or mismatched manifests and pins', async () => {
    const f = await fixture();
    await expect(preparePin({ ...f.options, pin: 'bad' })).rejects.toThrow(/invalid pin/);
    for (const manifest of [
      'not json',
      JSON.stringify({ entries: [] }),
      JSON.stringify({ entries: [{ path: '../outside' }] }),
    ]) {
      await writeFile(join(f.store, 'manifest.json'), manifest);
      await expect(preparePin(f.options)).rejects.toThrow();
    }
  });
});

describe('pin startup and diagnostics', () => {
  it('starts a real node child from the private copy and removes it after exit', async () => {
    const f = await fixture(
      false,
      'console.log(JSON.stringify({jsonrpc:"2.0",method:"location",params:{url:import.meta.url,cwd:process.cwd(),injected:process.env.NODE_OPTIONS??null}}));',
    );
    process.env['STROQ_HOME'] = f.home;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let text = '';
    stdout.on('data', (chunk) => {
      text += String(chunk);
    });
    const exit = await runMcpProxy({
      ...f.options,
      engine: createEngine(),
      sessionId: 'pin-test',
      cwd: f.home,
      passEnv: null,
      stdin,
      stdout,
      stderr,
    });
    expect(exit).toBe(0);
    const message = JSON.parse(text) as { params: { url: string; cwd: string; injected: unknown } };
    expect(message.params.url).toContain('stroq-mcp-pin-');
    expect(message.params.injected).toBeNull();
    await expect(readFile(join(message.params.cwd, 'server.mjs'))).rejects.toThrow();
  });

  it('refuses a drifted child before it can write a marker', async () => {
    const f = await fixture();
    process.env['STROQ_HOME'] = f.home;
    const marker = join(f.home, 'executed');
    await writeFile(
      f.options.args[0]!,
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'yes');`,
    );
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let text = '';
    stderr.on('data', (chunk) => {
      text += String(chunk);
    });
    expect(
      await runMcpProxy({
        ...f.options,
        engine: createEngine(),
        sessionId: 'pin-test',
        cwd: f.home,
        passEnv: [],
        stdin,
        stdout,
        stderr,
      }),
    ).toBe(1);
    expect(text).toContain('refusing to start');
    await expect(readFile(marker)).rejects.toThrow();
  });

  it('checks wrappers offline and reports invalid pins and drift', async () => {
    const f = await fixture();
    process.env['STROQ_HOME'] = f.home;
    const file = join(f.home, 'mcp.json');
    const args = [
      '/stroq/dist/index.js',
      'mcp',
      '--server',
      'demo',
      '--client',
      'cursor',
      '--pin',
      f.options.pin,
      '--',
      f.options.command,
      ...f.options.args,
    ];
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: { demo: { command: 'node', args }, foreign: { args: ['--pin', 'ignored'] } },
      }),
    );
    expect(await configPinStatus(file)).toMatchObject([{ ok: true }]);
    await writeFile(f.options.args[0]!, 'changed');
    expect(await configPinStatus(file)).toMatchObject([
      { ok: false, detail: expect.stringContaining('drifted') },
    ]);
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: { demo: { args: args.map((arg) => (arg === f.options.pin ? 'bad' : arg)) } },
      }),
    );
    expect(await configPinStatus(file)).toMatchObject([
      { ok: false, detail: expect.stringContaining('invalid') },
    ]);
    for (const config of [
      {},
      { mcpServers: [] },
      {
        mcpServers: {
          empty: null,
          scalar: 1,
          unwrapped: { args: [] },
          wrapped: {
            args: [
              '/stroq/dist/index.js',
              'mcp',
              '--server',
              'demo',
              '--client',
              'cursor',
              '--',
              'node',
              '/server.js',
              '--pin',
              'data',
            ],
          },
        },
      },
    ]) {
      await writeFile(file, JSON.stringify(config));
      expect(await configPinStatus(file)).toEqual([]);
    }
    await rm(file);
    expect(await configPinStatus(file)).toEqual([]);
  });

  it('reports changed pinned files through doctor and exposure', async () => {
    const f = await fixture();
    process.env['STROQ_HOME'] = f.home;
    const config = {
      mcpServers: {
        demo: {
          command: process.execPath,
          args: [
            join(import.meta.dirname, '../../src/index.ts'),
            'mcp',
            '--server',
            'demo',
            '--client',
            'claude-code',
            '--pin',
            f.options.pin,
            '--',
            f.options.command,
            ...f.options.args,
          ],
        },
      },
    };
    await writeFile(join(f.home, '.mcp.json'), JSON.stringify(config));
    expect((await doctorReport(f.home)).checks).toContainEqual(
      expect.objectContaining({ name: 'mcp pin "demo"', ok: true }),
    );
    await writeFile(f.options.args[0]!, 'changed');
    expect((await doctorReport(f.home)).checks).toContainEqual(
      expect.objectContaining({ name: 'mcp pin "demo"', ok: false }),
    );
    expect((await buildExposureReport(f.home, {})).findings).toContainEqual(
      expect.objectContaining({ class: 'mcp-pin-drifted', severity: 'high' }),
    );
  });
});

it('parses and validates --pin before starting any child', () => {
  const pin = `sha256:${'a'.repeat(64)}`;
  expect(
    parseMcpArgv(['--server', 'demo', '--pin', pin, '--', 'node', '/server.mjs']),
  ).toMatchObject({ ok: true, invocation: { pin } });
  expect(
    parseMcpArgv(['--server', 'demo', '--pin', 'invalid', '--', 'node', '/server.mjs']),
  ).toMatchObject({ ok: false });
});

it('preserves the pin through repeated wrapper rewrites, never taking the server argv pin', () => {
  const pin = `sha256:${'a'.repeat(64)}`;
  const opts = {
    node: '/usr/bin/node',
    entryArgv: ['/stroq/dist/index.js'],
    client: 'cursor',
    cwd: '/project',
  };
  const config = {
    mcpServers: {
      demo: {
        command: 'node',
        args: [
          '/stroq/dist/index.js',
          'mcp',
          '--server',
          'demo',
          '--client',
          'cursor',
          '--pin',
          pin,
          '--',
          'node',
          '/server.mjs',
          '--pin',
          'server-value',
        ],
      },
    },
  };
  const wrapped = wrapMcpConfig(config, opts).config;
  expect(JSON.stringify(wrapped)).toContain(pin);
  expect(wrapMcpConfig(wrapped, opts).config).toEqual(wrapped);
});
