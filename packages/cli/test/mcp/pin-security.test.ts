import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { preparePin } from '../../src/mcp/pin.js';
import { runMcpProxy } from '../../src/mcp/proxy.js';
import { createEngine } from '../../src/engine-factory.js';
import { fixture, roots } from './pin-fixture.js';

describe('pin security regressions', () => {
  it('relocates every whole absolute tree argument and rejects embedded store references', async () => {
    const f = await fixture(false, 'console.log("checked")', '{"checked":true}');
    const config = join(f.store, 'tree', 'config.json');
    const copy = await preparePin({
      ...f.options,
      args: [f.options.args[0]!, config, join(f.store, 'tree')],
    });
    try {
      await writeFile(config, 'changed after verification');
      expect(await readFile(copy.args[1]!, 'utf8')).toBe('{"checked":true}');
      expect(copy.args[1]).toBe(join(copy.cwd, 'config.json'));
      expect(copy.args[2]).toBe(copy.cwd);
      expect(dirname(copy.cwd)).toBe(join(f.home, 'run'));
      if (process.platform !== 'win32') {
        expect((await stat(dirname(copy.cwd))).mode & 0o777).toBe(0o700);
      }
    } finally {
      await copy.cleanup();
    }
    // Restore the verified tree so argument validation is the reason for refusal.
    await writeFile(config, '{"checked":true}');
    for (const arg of [`--config=${config}`, `file://${config}`, `prefix${f.store}/tree/suffix`]) {
      await expect(preparePin({ ...f.options, args: [f.options.args[0]!, arg] })).rejects.toThrow(
        /argument/,
      );
    }
  });

  it('refuses a symlinked store file even when its target has the confirmed bytes', async () => {
    const f = await fixture();
    const target = join(f.home, 'same.mjs');
    await writeFile(target, f.bytes);
    await rm(f.options.args[0]!);
    await symlink(target, f.options.args[0]!);
    await expect(preparePin(f.options)).rejects.toThrow(/verify|changed/);
  });

  it.each(['manifest.json', 'passports.json'])('refuses symlinked %s records', async (name) => {
    const f = await fixture();
    const file = name === 'manifest.json' ? join(f.store, name) : join(f.home, name);
    const target = join(f.home, `${name}.target`);
    await writeFile(target, await readFile(file));
    await rm(file);
    await symlink(target, file);
    await expect(preparePin(f.options)).rejects.toThrow(/linked|lock/);
  });

  it.runIf(process.platform !== 'win32')(
    'refuses a FIFO without opening or waiting for it',
    async () => {
      const f = await fixture();
      execFileSync('mkfifo', [join(f.store, 'tree', 'pipe')]);
      await expect(preparePin(f.options)).rejects.toThrow(/verify|changed/);
    },
  );

  it('reports an oversized lock distinctly', async () => {
    const f = await fixture();
    await writeFile(join(f.home, 'passports.json'), ' '.repeat(4 * 1024 * 1024 + 1));
    await expect(preparePin(f.options)).rejects.toThrow(/lock.*size|lock.*large/);
  });

  it('refuses an absolute tree argument that has no confirmed file or directory', async () => {
    const f = await fixture();
    await expect(
      preparePin({
        ...f.options,
        args: [...f.options.args, join(f.store, 'tree', 'missing.json')],
      }),
    ).rejects.toThrow(/argument/);
  });

  it('refuses a linked runtime folder instead of copying outside its private root', async () => {
    const f = await fixture();
    await symlink(f.store, join(f.home, 'run'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(preparePin(f.options)).rejects.toThrow(/linked/);
  });

  it('does not resolve an optional package planted above shared temporary copies', async () => {
    const f = await fixture(
      false,
      'import {createRequire} from "node:module";const require=createRequire(import.meta.url);let loaded=null;try{loaded=require("stroq-planted-optional")}catch{};console.log(JSON.stringify({jsonrpc:"2.0",method:"location",params:{loaded}}));',
    );
    const shared = await mkdtemp(join(tmpdir(), 'stroq-pin-shared-'));
    roots.push(shared);
    await mkdir(join(shared, 'node_modules', 'stroq-planted-optional'), { recursive: true });
    await writeFile(
      join(shared, 'node_modules', 'stroq-planted-optional', 'index.js'),
      'module.exports="UNVERIFIED-CODE-RAN";',
    );
    vi.stubEnv('TMPDIR', shared);
    vi.stubEnv('TEMP', shared);
    vi.stubEnv('TMP', shared);
    vi.stubEnv('STROQ_HOME', f.home);
    const stdout = new PassThrough();
    let text = '';
    stdout.on('data', (chunk) => {
      text += String(chunk);
    });
    expect(
      await runMcpProxy({
        ...f.options,
        engine: createEngine(),
        sessionId: 'pin-temp',
        cwd: f.home,
        passEnv: [],
        stdin: new PassThrough(),
        stdout,
        stderr: new PassThrough(),
      }),
    ).toBe(0);
    expect(JSON.parse(text)).toMatchObject({ params: { loaded: null } });
  });
});
