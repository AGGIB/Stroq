import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseMcpArgv } from '../../src/commands/mcp.js';
import { addMcp } from '../../src/install/mcp-install.js';
import { inspectPin, preparePin, type PinOptions } from '../../src/mcp/pin.js';
import { runMcpProxy } from '../../src/mcp/proxy.js';
import { mcpFixture } from '../helpers/mcp-install.js';

/**
 * The pin binds the wrapper that `add` wrote, not only the server name and the digest: the environment it
 * passes, the start file and the arguments. A wrapper in a client config is a file the agent can edit, and
 * an edit that gives the confirmed server another secret, or runs another file of the confirmed tree, or
 * adds arguments, must be refused with a reason a person can read.
 */
async function confirmed(files: Record<string, string> = {}, passEnv: string[] = ['API_KEY']) {
  const f = await mcpFixture({ 'debug.js': 'console.log("debug")\n', ...files });
  await addMcp(f.dir, { ...f.mcpOptions, passEnv });
  const entry = (await f.servers())['demo'] as { args: string[] };
  const wrapper = entry.args.slice(entry.args.indexOf('mcp') + 1);
  const options = (args: readonly string[]): PinOptions & { passEnv: readonly string[] | null } => {
    const parsed = parseMcpArgv(args);
    if (!parsed.ok) throw new Error(parsed.error);
    const { server, pin, command, args: rest, passEnv: names } = parsed.invocation;
    return { server, pin: pin!, command, args: rest, passEnv: names, home: f.options.stroqHome };
  };
  const edited = (change: (args: string[]) => string[] | void): string[] => {
    const copy = [...wrapper];
    return change(copy) ?? copy;
  };
  return { f, wrapper, options, edited };
}

const REFUSED_PHRASE = /no longer matches what was confirmed|not the one confirmed/;

describe('the pin binds the wrapper add wrote', () => {
  it('starts the wrapper as it was written', async () => {
    const { options, wrapper } = await confirmed();
    const launch = await preparePin(options(wrapper));
    await launch.cleanup();

    expect(await inspectPin(options(wrapper))).toMatchObject({ ok: true });
  });

  it('refuses a --pass-env that names another variable, and says it was the environment', async () => {
    const { options, wrapper, edited } = await confirmed();
    const tampered = edited((args) => {
      args[args.indexOf('--pass-env') + 1] = 'API_KEY,SECRET_TOKEN';
    });

    await expect(preparePin(options(tampered))).rejects.toThrow(/--pass-env/);
    const status = await inspectPin(options(tampered));
    expect(status.ok).toBe(false);
    expect(status.detail).toMatch(/--pass-env/);
    expect(status.detail).toMatch(REFUSED_PHRASE);
    expect(wrapper).toContain('API_KEY');
  });

  it('accepts the same variables in another order and with a repeat', async () => {
    const { options, edited } = await confirmed({}, ['A_KEY', 'B_KEY']);
    const reordered = edited((args) => {
      args[args.indexOf('--pass-env') + 1] = 'B_KEY,A_KEY,B_KEY';
    });

    const launch = await preparePin(options(reordered));
    await launch.cleanup();
  });

  it('refuses a variable taken out, and a --pass-env taken away (which would inherit everything)', async () => {
    const { options, edited } = await confirmed({}, ['A_KEY', 'B_KEY']);
    const fewer = edited((args) => {
      args[args.indexOf('--pass-env') + 1] = 'A_KEY';
    });
    const none = edited((args) => {
      args.splice(args.indexOf('--pass-env'), 2);
    });

    await expect(preparePin(options(fewer))).rejects.toThrow(/--pass-env/);
    await expect(preparePin(options(none))).rejects.toThrow(/--pass-env/);
  });

  it('refuses an empty list confirmed as none being given a variable', async () => {
    const { options, edited } = await confirmed({}, []);
    const tampered = edited((args) => {
      args[args.indexOf('--pass-env') + 1] = 'SECRET_TOKEN';
    });

    await expect(preparePin(options(tampered))).rejects.toThrow(/--pass-env/);
  });

  it('refuses another file of the confirmed tree as the start file', async () => {
    const { options, edited } = await confirmed();
    const tampered = edited((args) => {
      args[args.length - 1] = args[args.length - 1]!.replace('server.js', 'debug.js');
    });

    await expect(preparePin(options(tampered))).rejects.toThrow(/start file/);
    expect((await inspectPin(options(tampered))).detail).toMatch(/start file/);
  });

  it('refuses arguments added after the start file', async () => {
    const { options, edited } = await confirmed();
    const tampered = edited((args) => {
      args.push('--extra', 'evil-arg');
    });

    await expect(preparePin(options(tampered))).rejects.toThrow(/arguments/);
    expect((await inspectPin(options(tampered))).detail).toMatch(/arguments/);
  });

  it('refuses another way of naming node', async () => {
    const { options, edited } = await confirmed();
    const tampered = edited((args) => {
      args[args.lastIndexOf('node')] = process.execPath;
    });

    await expect(preparePin(options(tampered))).rejects.toThrow(/arguments/);
  });

  it('makes the proxy refuse to start, with the reason on its stderr and nothing spawned', async () => {
    const { options, edited } = await confirmed();
    const tampered = options(
      edited((args) => {
        args[args.indexOf('--pass-env') + 1] = 'SECRET_TOKEN';
      }),
    );
    let stderr = '';
    const sink = new PassThrough();
    sink.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const code = await runMcpProxy({
      ...tampered,
      client: 'claude-code',
      session: null,
      cwd: null,
      cloak: false,
      engine: undefined as never,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: sink,
    } as never);

    expect(code).toBe(1);
    expect(stderr).toMatch(/refusing to start/);
    expect(stderr).toMatch(/--pass-env/);
  });

  it('still accepts a hand-written record that has only the name, the digest and the pin', async () => {
    const { options, f, wrapper } = await confirmed();
    const lockFile = join(f.options.stroqHome, 'passports.json');
    const lock = JSON.parse(
      await (await import('node:fs/promises')).readFile(lockFile, 'utf8'),
    ) as {
      mcp: { demo: Record<string, unknown> };
    };
    const { kind, status, digest, grant } = lock.mcp.demo as Record<string, unknown>;
    lock.mcp.demo = { kind, status, digest, grant };
    await writeFile(lockFile, JSON.stringify(lock));
    const loose = [...wrapper];
    loose.push('--extra');

    // Nothing was recorded to compare with, so the check that existed before is the one that applies.
    expect(await inspectPin(options(wrapper))).toMatchObject({ ok: true });
    await expect(preparePin(options(loose))).resolves.toBeDefined();
  });
});
