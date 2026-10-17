import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMcpArgv } from '../../src/commands/mcp.js';
import {
  countStrict,
  countWrapped,
  unwrapArgs,
  unwrapMcpConfig,
  wrapMcpConfig,
  wrapperIndex,
  wrapperStrictArgs,
  type McpConfigJson,
  type WrapOptions,
} from '../../src/commands/mcp-config.js';

const entryDir = mkdtempSync(join(tmpdir(), 'stroq-mcp-strict-entry-'));
const realEntry = join(entryDir, 'index.js');
writeFileSync(realEntry, '');

const opts: WrapOptions = {
  node: '/usr/bin/node',
  entryArgv: [realEntry],
  client: 'claude-desktop',
  cwd: '/home/me/project',
};

const config = (servers: Record<string, unknown>) => ({ mcpServers: servers }) as McpConfigJson;
const argsOf = (value: McpConfigJson, name: string): unknown[] =>
  (value.mcpServers as Record<string, { args: unknown[] }>)[name]?.args ?? [];

describe('wrapMcpConfig with strict mode', () => {
  it('writes --strict after --pass-env and --cloak, before the separator', () => {
    const { config: out } = wrapMcpConfig(config({ a: { command: 'srv' } }), {
      ...opts,
      cloak: true,
      strict: true,
    });
    expect(argsOf(out, 'a')).toEqual([
      realEntry,
      'mcp',
      '--server',
      'a',
      '--client',
      'claude-desktop',
      '--cwd',
      '/home/me/project',
      '--pass-env',
      '',
      '--cloak',
      '--strict',
      '--',
      'srv',
    ]);
  });

  it('writes nothing for strict when it is not asked for, so a plain wrapper is unchanged', () => {
    const { config: out } = wrapMcpConfig(config({ a: { command: 'srv' } }), opts);
    expect(argsOf(out, 'a')).not.toContain('--strict');
  });

  it('is still recognised as a Stroq wrapper, and unwraps to the original command', () => {
    const once = wrapMcpConfig(config({ a: { command: 'srv', args: ['--port', '1'] } }), {
      ...opts,
      strict: true,
    });
    expect(wrapperIndex(argsOf(once.config, 'a'))).not.toBeNull();
    expect(unwrapArgs(argsOf(once.config, 'a'))).toEqual({ command: 'srv', args: ['--port', '1'] });
    const back = unwrapMcpConfig(once.config);
    expect(back.outcomes).toEqual([{ name: 'a', action: 'unwrapped' }]);
    expect((back.config.mcpServers as Record<string, unknown>)['a']).toEqual({
      command: 'srv',
      args: ['--port', '1'],
    });
  });

  it('keeps a strict wrapper strict when init is run again without the flag', () => {
    const strict = wrapMcpConfig(config({ a: { command: 'srv' } }), { ...opts, strict: true });
    const again = wrapMcpConfig(strict.config, opts);
    expect(again.outcomes).toEqual([{ name: 'a', action: 'already wrapped' }]);
    // A rewrite must not silently remove a check, as it must not remove a pin.
    expect(argsOf(again.config, 'a')).toContain('--strict');
    expect(argsOf(again.config, 'a').filter((a) => a === '--strict')).toHaveLength(1);
  });

  it('keeps the limit a wrapper was given, even one the proxy would refuse', () => {
    const wrapped = config({
      a: {
        command: '/usr/bin/node',
        args: [
          realEntry,
          'mcp',
          '--server',
          'a',
          '--client',
          'c',
          '--strict',
          '--strict-max-withheld',
          '7',
          '--',
          'srv',
        ],
      },
      b: {
        command: '/usr/bin/node',
        args: [
          realEntry,
          'mcp',
          '--server',
          'b',
          '--client',
          'c',
          '--strict-max-withheld',
          'junk',
          '--',
          'srv',
        ],
      },
    });
    const again = wrapMcpConfig(wrapped, { ...opts, strict: true });
    expect(argsOf(again.config, 'a').slice(-5)).toEqual([
      '--strict',
      '--strict-max-withheld',
      '7',
      '--',
      'srv',
    ]);
    expect(wrapperStrictArgs(argsOf(again.config, 'b'))).toEqual([
      '--strict',
      '--strict-max-withheld',
      'junk',
    ]);
  });

  it('turns strict on for a wrapper that was written without it', () => {
    const plain = wrapMcpConfig(config({ a: { command: 'srv' } }), opts);
    const strict = wrapMcpConfig(plain.config, { ...opts, strict: true });
    expect(argsOf(strict.config, 'a')).toContain('--strict');
    expect(unwrapArgs(argsOf(strict.config, 'a'))).toEqual({ command: 'srv', args: [] });
  });

  it.each(['7', '0', 'junk', ''])(
    'keeps an inline limit %j exactly, including a spelling the proxy refuses',
    (limit) => {
      const inline = `--strict-max-withheld=${limit}`;
      const wrapped = config({
        a: {
          command: '/usr/bin/node',
          args: [
            realEntry,
            'mcp',
            '--server',
            'a',
            '--client',
            'c',
            '--strict',
            inline,
            '--',
            'srv',
          ],
        },
      });
      const before = argsOf(wrapped, 'a') as string[];
      const again = wrapMcpConfig(wrapped, opts);
      const after = argsOf(again.config, 'a') as string[];
      expect(wrapperStrictArgs(after)).toEqual(['--strict', inline]);
      // A rewrite must not turn an option the parser refused into a runnable, weaker default.
      expect(parseMcpArgv(after.slice(after.indexOf('mcp') + 1)).ok).toBe(
        parseMcpArgv(before.slice(before.indexOf('mcp') + 1)).ok,
      );
      expect(unwrapArgs(after)).toEqual({ command: 'srv', args: [] });
    },
  );

  it('does not inherit an inline strict limit belonging to the server', () => {
    const wrapped = wrapMcpConfig(
      config({
        a: {
          command: 'srv',
          args: ['--strict-max-withheld=7'],
        },
      }),
      opts,
    );
    expect(wrapperStrictArgs(argsOf(wrapped.config, 'a'))).toEqual([]);
    expect(unwrapArgs(argsOf(wrapped.config, 'a'))).toEqual({
      command: 'srv',
      args: ['--strict-max-withheld=7'],
    });
  });

  it('does not read a --strict that belongs to the wrapped server', () => {
    const wrapped = wrapMcpConfig(config({ a: { command: 'srv', args: ['--strict'] } }), opts);
    expect(wrapperStrictArgs(argsOf(wrapped.config, 'a'))).toEqual([]);
    expect(countStrict(wrapped.config)).toBe(0);
  });
});

describe('countStrict, which is what doctor reports beside countWrapped', () => {
  it('counts the wrapped servers that run strict, and leaves countWrapped as it was', () => {
    const plain = wrapMcpConfig(config({ a: { command: 'x' }, b: { command: 'y' } }), opts);
    const strict = wrapMcpConfig(config({ c: { command: 'z' } }), { ...opts, strict: true });
    const mixed = config({
      ...(plain.config.mcpServers as Record<string, unknown>),
      ...(strict.config.mcpServers as Record<string, unknown>),
    });
    expect(countWrapped(mixed)).toEqual({ wrapped: 3, stdio: 3, stale: 0, unfiltered: 0 });
    expect(countStrict(mixed)).toBe(1);
  });

  it('does not count a stale wrapper or an unwrapped entry', () => {
    const stale = wrapMcpConfig(config({ a: { command: 'x' } }), {
      ...opts,
      entryArgv: ['/does/not/exist/index.js'],
      strict: true,
    });
    expect(countStrict(stale.config)).toBe(0);
    expect(countStrict(config({ a: { command: 'x', args: ['--strict'] } }))).toBe(0);
    expect(countStrict({ mcpServers: {} })).toBe(0);
  });
});
