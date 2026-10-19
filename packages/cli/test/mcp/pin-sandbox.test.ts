import { chmod, mkdir, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { PIN_SANDBOX_PHRASES } from '../../src/mcp/pin-argument.js';
import { inspectPin, preparePin } from '../../src/mcp/pin.js';
import { runMcpProxy } from '../../src/mcp/proxy.js';
import { fixture, roots } from './pin-fixture.js';

/**
 * Inside `stroq run --sandbox` the folder for the verified copy is denied on purpose, so a pinned server
 * cannot start there. The refusal says so, in a fixed phrase, and the sandbox phrase is used only when the
 * run is a sandboxed one. The disk is made to say "no" with a Stroq home that cannot be written.
 */
const root = typeof process.getuid === 'function' && process.getuid() === 0;
const posix = process.platform !== 'win32' && !root;

describe.skipIf(!posix)('a pinned server whose folder cannot be written', () => {
  async function locked() {
    const f = await fixture();
    // Not yet made: making it is what the sandbox denies.
    await chmod(f.home, 0o500);
    return f;
  }

  it('is refused in the words of the sandbox when the run is a sandboxed one', async () => {
    vi.stubEnv('STROQ_SECRET_SOURCES_SEALED', '1');
    const f = await locked();
    try {
      await expect(preparePin(f.options)).rejects.toThrow(PIN_SANDBOX_PHRASES[0]);
    } finally {
      await chmod(f.home, 0o700);
    }
  });

  it('is refused with the plain phrase when it is not', async () => {
    vi.stubEnv('STROQ_SECRET_SOURCES_SEALED', '');
    const f = await locked();
    try {
      await expect(preparePin(f.options)).rejects.toThrow(PIN_SANDBOX_PHRASES[1]);
    } finally {
      await chmod(f.home, 0o700);
    }
  });

  it('makes the proxy say it on its stderr, and not start', async () => {
    vi.stubEnv('STROQ_SECRET_SOURCES_SEALED', '1');
    const f = await locked();
    let stderr = '';
    const sink = new PassThrough();
    sink.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      const code = await runMcpProxy({
        ...f.options,
        client: 'claude-code',
        session: null,
        cwd: null,
        cloak: false,
        passEnv: [],
        engine: undefined as never,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: sink,
      } as never);

      expect(code).toBe(1);
      expect(stderr).toContain(PIN_SANDBOX_PHRASES[0]);
      expect(stderr).toContain('refusing to start');
    } finally {
      await chmod(f.home, 0o700);
    }
  });

  it('is not the sandbox phrase for a fault that is not a permission', async () => {
    const f = await fixture();
    await mkdir(join(f.home, 'run'), { recursive: true });
    const launch = await preparePin(f.options);
    await launch.cleanup();
  });

  it('does not change the mode of a home or run folder it did not create', async () => {
    const f = await fixture();
    await chmod(f.home, 0o755);
    const first = await preparePin(f.options);
    await first.cleanup();
    expect((await stat(f.home)).mode & 0o777).toBe(0o755);
    expect((await stat(join(f.home, 'run'))).mode & 0o777).toBe(0o700);

    await chmod(join(f.home, 'run'), 0o750);
    const second = await preparePin(f.options);
    await second.cleanup();
    expect((await stat(join(f.home, 'run'))).mode & 0o777).toBe(0o750);
  });

  it.each(['home', 'run'])(
    'refuses an existing %s writable by other users without changing its mode',
    async (parent) => {
      const f = await fixture();
      const folder = parent === 'home' ? f.home : join(f.home, 'run');
      await mkdir(folder, { recursive: true });
      await chmod(folder, 0o777);
      try {
        await expect(preparePin(f.options)).rejects.toThrow(
          'cannot use a runtime folder writable by other users',
        );
        expect((await stat(folder)).mode & 0o777).toBe(0o777);
      } finally {
        await chmod(folder, 0o700);
      }
    },
  );
});

describe('a linked Stroq home or store folder', () => {
  it('is refused by preparePin, inspectPin and runMcpProxy with the fixed phrase and no path bytes', async () => {
    const f = await fixture();
    const linkedHome = `${f.home}-link`;
    roots.push(linkedHome);
    await symlink(f.home, linkedHome, process.platform === 'win32' ? 'junction' : 'dir');
    const options = {
      ...f.options,
      home: linkedHome,
      args: [join(linkedHome, 'store', `sha256-${f.digest.slice(0, 32)}`, 'tree', 'server.mjs')],
    };

    await expect(preparePin(options)).rejects.toThrow('cannot verify a linked store folder');
    expect(await inspectPin(options)).toEqual({
      ok: false,
      detail:
        'cannot verify a linked store folder; start refused (tamper-evident, not tamper-proof)',
    });

    let stderr = '';
    const sink = new PassThrough();
    sink.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const code = await runMcpProxy({
      ...options,
      client: 'claude-code',
      session: null,
      cwd: null,
      cloak: false,
      passEnv: [],
      engine: undefined as never,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: sink,
    } as never);
    expect(code).toBe(1);
    expect(stderr).toBe('stroq mcp: cannot verify a linked store folder; refusing to start\n');
    expect(stderr).not.toContain(linkedHome);
  });
});

describe('doctor and the sandbox', () => {
  it('notes, among its checks, that a pinned server cannot start inside stroq run --sandbox', async () => {
    const { doctorReport } = await import('../../src/commands/doctor.js');
    const f = await fixture();

    const report = await doctorReport(f.home, { home: f.home });
    const check = report.checks.find((c) => c.name === 'mcp pins and the sandbox');

    expect(check).toMatchObject({ ok: true });
    expect(check?.detail).toMatch(/1 pinned MCP server \("demo"\)/);
    expect(check?.detail).toMatch(/cannot start inside `stroq run --sandbox`/);
    expect(check?.detail).toMatch(/not measured with a real srt/);
  });

  it('has no such check when nothing is pinned', async () => {
    const { doctorReport } = await import('../../src/commands/doctor.js');
    const f = await fixture();
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(join(f.home, 'passports.json'), JSON.stringify({ v: 1, skills: {}, mcp: {} })),
    );

    const report = await doctorReport(f.home, { home: f.home });

    expect(report.checks.map((c) => c.name)).not.toContain('mcp pins and the sandbox');
  });
});
