import fc from 'fast-check';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { parseMcpArgv } from '../../src/commands/mcp.js';
import { addMcp } from '../../src/install/mcp-install.js';
import { configPinStatus } from '../../src/mcp/pin-status.js';
import { inspectPin, preparePin, type PinOptions } from '../../src/mcp/pin.js';
import { runMcpProxy } from '../../src/mcp/proxy.js';
import { mcpFixture } from '../helpers/mcp-install.js';

/**
 * The pin binds the wrapper that `add` wrote, exactly. A wrapper in a client config is a file the agent can
 * edit, and the lock holds what `add` wrote (`written`): the command, every argument in order (the Stroq
 * entry, `--server`, `--client`, `--pin`, `--cwd`, `--pass-env`, the command after `--`). The proxy is
 * given the argv it was started with and compares it with `written` token by token; `doctor` compares the
 * whole config entry, which also holds `env`, `cwd` and any other key. A difference of any kind is a
 * refusal, in a fixed phrase that holds nothing of the wrapper.
 */
async function confirmed(files: Record<string, string> = {}, passEnv: string[] = ['API_KEY']) {
  const f = await mcpFixture({ 'debug.js': 'console.log("debug")\n', ...files });
  await addMcp(f.dir, { ...f.mcpOptions, passEnv });
  const entry = (await f.servers())['demo'] as { command: string; args: string[] };
  const full = [entry.command, ...entry.args];
  /** The pin options a proxy started with this command line would have, or null when it would not start. */
  const asRun = (
    line: readonly string[],
  ): (PinOptions & { passEnv: readonly string[] | null }) | null => {
    const at = line.indexOf('mcp');
    if (at === -1) return null;
    const parsed = parseMcpArgv(line.slice(at + 1));
    if (!parsed.ok) return null;
    const { server, pin, command, args, passEnv: names } = parsed.invocation;
    return {
      server,
      pin: pin!,
      command,
      args,
      passEnv: names,
      home: f.options.stroqHome,
      launch: { command: line[0]!, argv: line.slice(1) },
    };
  };
  /** What happens to a command line: 'accepted', or the reason it is refused. */
  const verdict = async (line: readonly string[]): Promise<string> => {
    const options = asRun(line);
    if (options === null) return 'does not parse';
    const status = await inspectPin(options);
    return status.ok ? 'accepted' : status.detail;
  };
  const edit = (change: (line: string[]) => void): string[] => {
    const copy = [...full];
    change(copy);
    return copy;
  };
  return { f, entry, full, asRun, verdict, edit };
}

const value = (line: string[], flag: string): number => line.indexOf(flag) + 1;

describe('the pin binds the wrapper add wrote, exactly', () => {
  it('starts the wrapper as it was written', async () => {
    const { asRun, verdict, full } = await confirmed();
    const launch = await preparePin(asRun(full)!);
    await launch.cleanup();

    expect(await verdict(full)).toBe('accepted');
  });

  it('refuses a launch it cannot compare: a recorded entry and no command line', async () => {
    const { asRun, full } = await confirmed();
    const { launch: _launch, ...without } = asRun(full)!;

    await expect(preparePin(without)).rejects.toThrow(/cannot be compared/);
    expect((await inspectPin(without)).detail).toMatch(/cannot be compared/);
  });

  describe('every spelling of the environment it passes', () => {
    it.each([
      [
        'another variable added',
        (l: string[]) => (l[value(l, '--pass-env')] = 'API_KEY,SECRET_TOKEN'),
      ],
      ['an empty value', (l: string[]) => (l[value(l, '--pass-env')] = '')],
      ['another case', (l: string[]) => (l[value(l, '--pass-env')] = 'api_key')],
      ['a repeat', (l: string[]) => (l[value(l, '--pass-env')] = 'API_KEY,API_KEY')],
      ['NODE_OPTIONS', (l: string[]) => (l[value(l, '--pass-env')] = 'API_KEY,NODE_OPTIONS')],
      ['NODE_PATH', (l: string[]) => (l[value(l, '--pass-env')] = 'API_KEY,NODE_PATH')],
      ['LD_PRELOAD', (l: string[]) => (l[value(l, '--pass-env')] = 'API_KEY,LD_PRELOAD')],
      [
        'DYLD_INSERT_LIBRARIES',
        (l: string[]) => (l[value(l, '--pass-env')] = 'API_KEY,DYLD_INSERT_LIBRARIES'),
      ],
      ['HOME', (l: string[]) => (l[value(l, '--pass-env')] = 'API_KEY,HOME')],
      ['PATH', (l: string[]) => (l[value(l, '--pass-env')] = 'API_KEY,PATH')],
      [
        'the --pass-env=NAME spelling',
        (l: string[]) => l.splice(l.indexOf('--pass-env'), 2, '--pass-env=API_KEY'),
      ],
      ['the flag taken away', (l: string[]) => l.splice(l.indexOf('--pass-env'), 2)],
      [
        'the flag given twice',
        (l: string[]) => l.splice(l.indexOf('--pass-env'), 0, '--pass-env', 'OTHER'),
      ],
      [
        'the flag given twice, the same',
        (l: string[]) => l.splice(l.indexOf('--pass-env'), 0, '--pass-env', 'API_KEY'),
      ],
    ])('refuses %s', async (_what, change) => {
      const { verdict, edit } = await confirmed();

      expect(await verdict(edit(change))).not.toBe('accepted');
    });

    it('refuses one of two variables taken out, and says it was the environment', async () => {
      const { verdict, edit } = await confirmed({}, ['A_KEY', 'B_KEY']);

      expect(await verdict(edit((l) => (l[value(l, '--pass-env')] = 'A_KEY')))).toMatch(/pass-env/);
    });

    it('refuses the same variables in another order, and says it was the command line', async () => {
      const { verdict, edit } = await confirmed({}, ['A_KEY', 'B_KEY']);
      const reordered = edit((l) => (l[value(l, '--pass-env')] = 'B_KEY,A_KEY'));

      expect(await verdict(reordered)).toMatch(/command line/);
    });

    it('says that it was the environment when the names differ', async () => {
      const { verdict, edit } = await confirmed();

      expect(await verdict(edit((l) => (l[value(l, '--pass-env')] = 'SECRET_TOKEN')))).toMatch(
        /--pass-env/,
      );
    });

    it('refuses a variable given to a server confirmed with none', async () => {
      const { verdict, edit } = await confirmed({}, []);

      expect(await verdict(edit((l) => (l[value(l, '--pass-env')] = 'SECRET_TOKEN')))).toMatch(
        /--pass-env/,
      );
    });
  });

  describe('every other part of the command line', () => {
    it.each([
      ['another --cwd', (l: string[]) => (l[value(l, '--cwd')] = '/tmp/elsewhere')],
      ['--cwd taken away', (l: string[]) => l.splice(l.indexOf('--cwd'), 2)],
      ['another --client', (l: string[]) => (l[value(l, '--client')] = 'cursor')],
      ['another --server', (l: string[]) => (l[value(l, '--server')] = 'other')],
      [
        'a --session added',
        (l: string[]) => l.splice(l.indexOf('--'), 0, '--session', 'mcp:shared'),
      ],
      ['--cloak added', (l: string[]) => l.splice(l.indexOf('--'), 0, '--cloak')],
      ['--strict added', (l: string[]) => l.splice(l.indexOf('--'), 0, '--strict')],
      [
        '--strict-max-withheld added',
        (l: string[]) => l.splice(l.indexOf('--'), 0, '--strict-max-withheld', '9'),
      ],
      [
        'a second --pin with another digest',
        (l: string[]) => l.splice(l.indexOf('--'), 0, '--pin', `sha256:${'0'.repeat(64)}`),
      ],
      [
        'a second --pin with the same digest',
        (l: string[]) => l.splice(l.indexOf('--'), 0, '--pin', l[value(l, '--pin')]!),
      ],
      [
        'the --pin=DIGEST spelling',
        (l: string[]) => l.splice(l.indexOf('--pin'), 2, `--pin=${l[value(l, '--pin')]}`),
      ],
      ['--pin moved after --', (l: string[]) => l.push(...l.splice(l.indexOf('--pin'), 2))],
      ['--pin taken out', (l: string[]) => l.splice(l.indexOf('--pin'), 2)],
      [
        'another digest in --pin',
        (l: string[]) => (l[value(l, '--pin')] = `sha256:${'f'.repeat(64)}`),
      ],
      ['a trailing argument', (l: string[]) => l.push('--extra', 'evil-arg')],
      ['an empty trailing argument', (l: string[]) => l.push('')],
      [
        'another file of the tree as the start file',
        (l: string[]) => (l[l.length - 1] = l[l.length - 1]!.replace('server.js', 'debug.js')),
      ],
      ['no start file', (l: string[]) => l.pop()],
      [
        'another way of naming node',
        (l: string[]) => (l[l.lastIndexOf('node')] = process.execPath),
      ],
      ['another node for the proxy', (l: string[]) => (l[0] = '/usr/bin/env')],
      ['a flag for node before the Stroq entry', (l: string[]) => l.splice(1, 0, '--inspect')],
      [
        '--import before the Stroq entry',
        (l: string[]) => l.splice(1, 0, '--import', '/tmp/evil.mjs'),
      ],
      [
        'another Stroq entry',
        (l: string[]) => (l[l.indexOf('mcp') - 1] = '/tmp/not-stroq/index.js'),
      ],
      [
        'an argument between the entry and mcp',
        (l: string[]) => l.splice(l.indexOf('mcp'), 0, '--x'),
      ],
    ])('refuses %s', async (_what, change) => {
      const { verdict, edit } = await confirmed();
      const result = await verdict(edit(change));

      expect(result).not.toBe('accepted');
      // The reason is one of the fixed phrases, or that the line does not parse: nothing of the line itself.
      expect(result).not.toContain('evil');
      expect(result).not.toContain('/tmp/');
    });

    it('says that the start file was the difference when it is', async () => {
      const { verdict, edit } = await confirmed();
      const other = edit(
        (l) => (l[l.length - 1] = l[l.length - 1]!.replace('server.js', 'debug.js')),
      );

      expect(await verdict(other)).toMatch(/start file/);
    });

    it('says that the command line was the difference when arguments are added', async () => {
      const { verdict, edit } = await confirmed();

      expect(await verdict(edit((l) => l.push('--extra', 'evil-arg')))).toMatch(/command line/);
    });
  });

  it('refuses any change of a single token of the command line', async () => {
    const { verdict, full } = await confirmed();
    expect(await verdict(full)).toBe('accepted');
    const alphabet = [
      '',
      'x',
      '--',
      '--pass-env',
      '--pin',
      'node',
      'mcp',
      '/tmp/x',
      'API_KEY',
      '--cloak',
    ];
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: full.length }),
        fc.constantFrom('replace', 'insert', 'delete', 'swap'),
        fc.oneof(fc.constantFrom(...alphabet), fc.string({ maxLength: 12 })),
        async (index, how, token) => {
          const line = [...full];
          const at = Math.min(index, line.length - 1);
          if (how === 'replace') {
            if (line[at] === token) return;
            line[at] = token;
          } else if (how === 'insert') line.splice(index, 0, token);
          else if (how === 'delete') line.splice(at, 1);
          else if (at + 1 < line.length && line[at] !== line[at + 1]) {
            [line[at], line[at + 1]] = [line[at + 1]!, line[at]!];
          } else return;

          expect(await verdict(line), JSON.stringify(line)).not.toBe('accepted');
        },
      ),
      { numRuns: 400 },
    );
  });

  it('makes the proxy refuse to start, with the reason on its stderr and nothing spawned', async () => {
    const { asRun, edit } = await confirmed();
    const tampered = asRun(edit((l) => (l[value(l, '--pass-env')] = 'SECRET_TOKEN')))!;
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
    // the line to run is named, with the real name of the server, and nothing of the wrapper is in it
    expect(stderr).toContain('stroq add demo --kind mcp --force');
    expect(stderr).not.toContain('SECRET_TOKEN');
  });

  it('names the same command in the status doctor reads from a wrapper that is not the one confirmed', async () => {
    const { asRun, edit } = await confirmed();
    const status = await inspectPin(asRun(edit((l) => l.push('--extra')))!);

    expect(status.ok).toBe(false);
    expect(status.detail).toContain('stroq add demo --kind mcp --force');
  });

  it('refuses a lock record of another kind under the same name', async () => {
    const { verdict, full, f } = await confirmed();
    const lockFile = join(f.options.stroqHome, 'passports.json');
    const lock = JSON.parse(await readFile(lockFile, 'utf8')) as {
      mcp: { demo: Record<string, unknown> };
    };
    await writeFile(
      lockFile,
      JSON.stringify({ ...lock, mcp: { demo: { ...lock.mcp.demo, kind: 'skill' } } }),
    );

    expect(await verdict(full)).not.toBe('accepted');
  });

  it('still accepts a hand-written record that has only the name, the digest and the pin', async () => {
    const { verdict, full, edit, f } = await confirmed();
    const lockFile = join(f.options.stroqHome, 'passports.json');
    const lock = JSON.parse(await readFile(lockFile, 'utf8')) as {
      mcp: { demo: Record<string, unknown> };
    };
    const { kind, status, digest, grant } = lock.mcp.demo;
    await writeFile(
      lockFile,
      JSON.stringify({ ...lock, mcp: { demo: { kind, status, digest, grant } } }),
    );

    // Nothing was recorded to compare with, so the check that existed before is the one that applies.
    expect(await verdict(full)).toBe('accepted');
    expect(await verdict(edit((l) => l.push('--extra')))).toBe('accepted');
  });
});

describe('doctor compares the whole config entry with the one confirmed', () => {
  async function inConfig(change: (entry: Record<string, unknown>) => void) {
    const c = await confirmed();
    vi.stubEnv('STROQ_HOME', c.f.options.stroqHome);
    const config = JSON.parse(await readFile(c.f.config, 'utf8')) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    change(config.mcpServers['demo']!);
    await writeFile(c.f.config, JSON.stringify(config));
    return configPinStatus(c.f.config);
  }

  it('is satisfied by the entry as it was written', async () => {
    expect(await inConfig(() => undefined)).toMatchObject([{ ok: true }]);
  });

  it.each([
    [
      'an env block',
      (e: Record<string, unknown>) => (e['env'] = { NODE_OPTIONS: '--require /tmp/x' }),
    ],
    ['a cwd', (e: Record<string, unknown>) => (e['cwd'] = '/tmp')],
    ['a shell', (e: Record<string, unknown>) => (e['shell'] = true)],
    ['a type', (e: Record<string, unknown>) => (e['type'] = 'http')],
    ['a url', (e: Record<string, unknown>) => (e['url'] = 'https://evil.example/mcp')],
    [
      'an argument',
      (e: Record<string, unknown>) => (e['args'] = [...(e['args'] as string[]), '--x']),
    ],
    ['another command', (e: Record<string, unknown>) => (e['command'] = '/usr/bin/env')],
  ])('reports %s as not the confirmed entry', async (_what, change) => {
    const statuses = await inConfig(change);

    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ ok: false });
    expect(statuses[0]!.detail).toMatch(/not the one confirmed|not the ones confirmed/);
    expect(statuses[0]!.detail).not.toContain('evil');
  });

  it('reports a wrapper whose --pin was taken out, which the lock says was confirmed', async () => {
    const statuses = await inConfig((e) => {
      const args = e['args'] as string[];
      args.splice(args.indexOf('--pin'), 2);
    });

    expect(statuses).toMatchObject([{ ok: false }]);
    expect(statuses[0]!.detail).toMatch(/pin/);
    expect(statuses[0]!.detail).toContain('stroq add demo --kind mcp --force');
  });

  it('names the command that confirms the entry again when the entry is not the confirmed one', async () => {
    const statuses = await inConfig((e) => (e['cwd'] = '/tmp'));

    expect(statuses[0]!.detail).toContain('stroq add demo --kind mcp --force');
  });
});
