import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MCP_CLIENTS,
  claudeDesktopPath,
  countWrapped,
  hasValidMcpServers,
  isMcpClient,
  mcpConfigPath,
  readMcpConfig,
  unwrapArgs,
  unwrapMcpConfig,
  wrapMcpConfig,
  wrapperIndex,
  type McpConfigJson,
  type WrapOptions,
} from '../../src/commands/mcp-config.js';

const opts: WrapOptions = {
  node: '/usr/bin/node',
  entryArgv: ['/x/dist/index.js'],
  client: 'claude-desktop',
  cwd: '/home/me/project',
};

const config = (servers: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ ...extra, mcpServers: servers }) as McpConfigJson;

const serversOf = (value: McpConfigJson) =>
  value.mcpServers as Record<string, Record<string, unknown>>;

describe('the config file each client keeps its stdio servers in', () => {
  it('knows four clients and rejects anything else', () => {
    expect([...MCP_CLIENTS]).toEqual(['claude-desktop', 'windsurf', 'cursor', 'claude-code']);
    expect(isMcpClient('cursor')).toBe(true);
    expect(isMcpClient('vscode')).toBe(false);
  });

  it('puts the project clients under the working directory and the rest under home', () => {
    expect(mcpConfigPath('cursor', 'project', '/w')).toBe(join('/w', '.cursor', 'mcp.json'));
    expect(mcpConfigPath('cursor', 'user', '/w')).toBe(join(homedir(), '.cursor', 'mcp.json'));
    // `.mcp.json` is a project file; `--user` has no meaning for it.
    expect(mcpConfigPath('claude-code', 'user', '/w')).toBe(join('/w', '.mcp.json'));
    expect(mcpConfigPath('claude-desktop', 'project', '/w')).toContain(
      'claude_desktop_config.json',
    );
    // Windsurf prefers the path current IDE builds write, falling back to the
    // documented one when that does not exist; on a machine with neither, the
    // documented path is what the error message will name.
    expect(mcpConfigPath('windsurf', 'user', '/w')).toContain('mcp_config.json');
    expect(mcpConfigPath('windsurf', 'user', '/w').startsWith(join(homedir(), '.codeium'))).toBe(
      true,
    );
  });
});

describe('claudeDesktopPath', () => {
  it('resolves the three documented locations, and falls back when APPDATA is unset', () => {
    expect(claudeDesktopPath('darwin', {}, '/home/x')).toBe(
      join('/home/x', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    );
    expect(
      claudeDesktopPath('win32', { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'C:\\Users\\x'),
    ).toBe(join('C:\\Users\\x\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'));
    expect(claudeDesktopPath('win32', {}, 'C:\\Users\\x')).toBe(
      join('C:\\Users\\x', 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
    );
    expect(claudeDesktopPath('linux', {}, '/home/x')).toBe(
      join('/home/x', '.config', 'Claude', 'claude_desktop_config.json'),
    );
  });
});

describe('recognising Stroq own wrapper', () => {
  it('needs the entry path, the mcp/--server/--client run and a separator', () => {
    expect(
      wrapperIndex(['/x/dist/index.js', 'mcp', '--server', 'a', '--client', 'c', '--', 'node']),
    ).toBe(1);
    expect(
      wrapperIndex([
        '--import',
        'tsx',
        '/x/src/index.ts',
        'mcp',
        '--server',
        'a',
        '--client',
        'c',
        '--',
        'n',
      ]),
    ).toBe(3);
    expect(
      wrapperIndex(['/usr/local/bin/stroq', 'mcp', '--server', 'a', '--client', 'c', '--', 'n']),
    ).toBe(1);
    // A foreign server whose own argv happens to say `mcp --server` is NOT wrapped;
    // without the entry-path test it would read as wrapped and never be protected.
    expect(wrapperIndex(['server.js', 'mcp', '--server', 'x'])).toBeNull();
    expect(wrapperIndex(['/x/dist/index.js', 'mcp', '--server', 'a'])).toBeNull();
    expect(wrapperIndex(['/x/dist/index.js', 'hook', 'claude-code'])).toBeNull();
    expect(wrapperIndex([])).toBeNull();
  });

  it('is not fooled by a foreign entry with an index.js path and mcp/--server but no --client', () => {
    // Same entry-basename shape and the same `mcp`/`--server` tokens as a real wrap,
    // but nothing requires `--client` right after the name for a foreign server —
    // without that extra check this would misread as Stroq's own wrapper and get
    // destructively "unwrapped" or replaced instead of wrapped fresh.
    expect(wrapperIndex(['./dist/index.js', 'mcp', '--server', 'foo', '--', 'x'])).toBeNull();
  });

  it('recovers the original command from after the separator', () => {
    expect(
      unwrapArgs([
        '/x/dist/index.js',
        'mcp',
        '--server',
        'a',
        '--client',
        'c',
        '--',
        'npx',
        '-y',
        'srv',
        '--flag',
      ]),
    ).toEqual({ command: 'npx', args: ['-y', 'srv', '--flag'] });
    // A `--` in the SERVER's own arguments is after ours, so it is kept.
    expect(
      unwrapArgs([
        '/x/dist/index.js',
        'mcp',
        '--server',
        'a',
        '--client',
        'c',
        '--',
        'npx',
        '--',
        'x',
      ]),
    ).toEqual({ command: 'npx', args: ['--', 'x'] });
    expect(unwrapArgs(['server.js'])).toBeNull();
  });
});

describe('wrapMcpConfig', () => {
  it('rewrites a stdio entry and keeps every other key of it', () => {
    const { config: out, outcomes } = wrapMcpConfig(
      config({ github: { command: 'npx', args: ['-y', 'srv'], env: { TOKEN: 'x' }, extra: 1 } }),
      opts,
    );
    expect(outcomes).toEqual([{ name: 'github', action: 'wrapped' }]);
    expect(serversOf(out)['github']).toEqual({
      command: '/usr/bin/node',
      args: [
        '/x/dist/index.js',
        'mcp',
        '--server',
        'github',
        '--client',
        'claude-desktop',
        '--cwd',
        '/home/me/project',
        '--',
        'npx',
        '-y',
        'srv',
      ],
      env: { TOKEN: 'x' },
      extra: 1,
    });
  });

  it('inserts the tsx loader exactly where hookArgv puts it', () => {
    // In development the entry is a `.ts` file and `hookArgv` prefixes `--import tsx`;
    // the wrapper has to carry the same prefix or the server never starts.
    const dev = wrapMcpConfig(config({ a: { command: 'srv' } }), {
      ...opts,
      entryArgv: ['--import', 'tsx', '/x/src/index.ts'],
    });
    expect(serversOf(dev.config)['a']?.['args']).toEqual([
      '--import',
      'tsx',
      '/x/src/index.ts',
      'mcp',
      '--server',
      'a',
      '--client',
      'claude-desktop',
      '--cwd',
      '/home/me/project',
      '--',
      'srv',
    ]);
  });

  it('replaces its own wrapper instead of nesting one, so an upgrade updates the path', () => {
    const once = wrapMcpConfig(config({ a: { command: 'srv', args: ['--port', '1'] } }), opts);
    const twice = wrapMcpConfig(once.config, { ...opts, entryArgv: ['/new/dist/index.js'] });
    expect(twice.outcomes).toEqual([{ name: 'a', action: 'already wrapped' }]);
    expect(serversOf(twice.config)['a']).toEqual({
      command: '/usr/bin/node',
      args: [
        '/new/dist/index.js',
        'mcp',
        '--server',
        'a',
        '--client',
        'claude-desktop',
        '--cwd',
        '/home/me/project',
        '--',
        'srv',
        '--port',
        '1',
      ],
    });
  });

  it('does not mistake a foreign entry that merely looks wrapped for its own', () => {
    // Same `mcp`/`--server` tokens and an `index.js`-shaped path as a real wrap, but
    // no `--client` right after the name: a foreign server, not Stroq's own wrapper.
    // Wrapping it must preserve its command and args verbatim behind the new
    // wrapper's own `--`, rather than misreading part of them as Stroq's structure.
    const foreign = wrapMcpConfig(
      config({ foo: { command: './dist/index.js', args: ['mcp', '--server', 'foo', '--', 'x'] } }),
      opts,
    );
    expect(foreign.outcomes).toEqual([{ name: 'foo', action: 'wrapped' }]);
    expect(serversOf(foreign.config)['foo']?.['args']).toEqual([
      '/x/dist/index.js',
      'mcp',
      '--server',
      'foo',
      '--client',
      'claude-desktop',
      '--cwd',
      '/home/me/project',
      '--',
      './dist/index.js',
      'mcp',
      '--server',
      'foo',
      '--',
      'x',
    ]);
    // A second wrap of the RESULT is correctly recognised as Stroq's own this time.
    const again = wrapMcpConfig(foreign.config, opts);
    expect(again.outcomes).toEqual([{ name: 'foo', action: 'already wrapped' }]);
  });

  it('skips HTTP entries and entries with no command, and preserves order and foreign keys', () => {
    const { config: out, outcomes } = wrapMcpConfig(
      config(
        {
          alpha: { command: 'a' },
          remote: { url: 'https://mcp.example/sse', headers: { A: '1' } },
          windsurfRemote: { serverUrl: 'https://mcp.example/sse' },
          broken: { note: 'no command here' },
          zulu: { command: 'z' },
        },
        { schemaVersion: 3 },
      ),
      opts,
    );
    expect(outcomes).toEqual([
      { name: 'alpha', action: 'wrapped' },
      { name: 'remote', action: 'skipped (http)' },
      { name: 'windsurfRemote', action: 'skipped (http)' },
      { name: 'broken', action: 'skipped (no command)' },
      { name: 'zulu', action: 'wrapped' },
    ]);
    expect(Object.keys(serversOf(out))).toEqual([
      'alpha',
      'remote',
      'windsurfRemote',
      'broken',
      'zulu',
    ]);
    expect(serversOf(out)['remote']).toEqual({
      url: 'https://mcp.example/sse',
      headers: { A: '1' },
    });
    expect(out['schemaVersion']).toBe(3);
  });

  it('leaves an entry that is not an object alone rather than replacing it', () => {
    const { config: out, outcomes } = wrapMcpConfig(config({ odd: 'a bare string' }), opts);
    expect(outcomes).toEqual([{ name: 'odd', action: 'skipped (not an object)' }]);
    expect(out.mcpServers).toEqual({ odd: 'a bare string' });
  });

  it('tolerates a file with no mcpServers at all', () => {
    const { config: out, outcomes } = wrapMcpConfig({ other: 1 } as McpConfigJson, opts);
    expect(outcomes).toEqual([]);
    expect(out).toEqual({ other: 1, mcpServers: {} });
  });

  it('coerces a non-string arg instead of dropping it', () => {
    // Node's `child_process.spawn` stringifies argv anyway; dropping a numeric or
    // boolean element instead of coercing it would silently shorten the server's
    // real argv (e.g. a dangling `--port` with its value gone).
    const { outcomes, config: out } = wrapMcpConfig(
      config({ a: { command: 'node', args: ['s.js', '--port', 8080, '--verbose', true] } }),
      opts,
    );
    expect(outcomes).toEqual([{ name: 'a', action: 'wrapped' }]);
    expect(serversOf(out)['a']?.['args']).toEqual([
      '/x/dist/index.js',
      'mcp',
      '--server',
      'a',
      '--client',
      'claude-desktop',
      '--cwd',
      '/home/me/project',
      '--',
      'node',
      's.js',
      '--port',
      '8080',
      '--verbose',
      'true',
    ]);
    // Unwrapping restores the coerced (now all-string) list, not the original types.
    const restored = unwrapMcpConfig(out);
    expect(serversOf(restored.config)['a']).toEqual({
      command: 'node',
      args: ['s.js', '--port', '8080', '--verbose', 'true'],
    });
  });

  it('refuses to wrap an entry whose args is present but not an array', () => {
    const { outcomes, config: out } = wrapMcpConfig(
      config({ a: { command: 'node', args: '--port 8080' } }),
      opts,
    );
    expect(outcomes).toEqual([{ name: 'a', action: 'skipped (args is not an array)' }]);
    expect(serversOf(out)['a']).toEqual({ command: 'node', args: '--port 8080' });
  });

  it('never replaces a present-but-invalid mcpServers with an empty object', () => {
    // A hand edit that turned `mcpServers` into an array (or any other non-object
    // shape) is real user data; silently rewriting it to `{}` would destroy every
    // server in the file. This function returns the config untouched instead.
    const bad = { mcpServers: ['not', 'an', 'object'] } as unknown as McpConfigJson;
    const { config: out, outcomes } = wrapMcpConfig(bad, opts);
    expect(outcomes).toEqual([]);
    expect(out).toEqual(bad);
    expect(hasValidMcpServers(bad)).toBe(false);
    expect(hasValidMcpServers({ mcpServers: {} })).toBe(true);
    expect(hasValidMcpServers({})).toBe(true);
  });
});

describe('unwrapMcpConfig', () => {
  it('restores the original command and says what it did', () => {
    const wrapped = wrapMcpConfig(
      config({ a: { command: 'srv', args: ['--port', '1'], env: {} } }),
      opts,
    );
    const { config: out, outcomes } = unwrapMcpConfig(wrapped.config);
    expect(outcomes).toEqual([{ name: 'a', action: 'unwrapped' }]);
    expect(serversOf(out)['a']).toEqual({ command: 'srv', args: ['--port', '1'], env: {} });
  });

  it('writes an empty args array for a command that took none', () => {
    const wrapped = wrapMcpConfig(config({ a: { command: 'srv' } }), opts);
    expect(serversOf(unwrapMcpConfig(wrapped.config).config)['a']).toEqual({
      command: 'srv',
      args: [],
    });
  });

  it('leaves an entry it never wrapped alone', () => {
    const { config: out, outcomes } = unwrapMcpConfig(
      config({ a: { command: 'srv' }, remote: { url: 'https://x.example' } }),
    );
    expect(outcomes).toEqual([
      { name: 'a', action: 'not wrapped' },
      { name: 'remote', action: 'skipped (http)' },
    ]);
    expect(serversOf(out)['a']).toEqual({ command: 'srv' });
  });

  it('refuses to unwrap an entry whose args is present but not an array', () => {
    const { outcomes, config: out } = unwrapMcpConfig(
      config({ a: { command: 'node', args: '--port 8080' } }),
    );
    expect(outcomes).toEqual([{ name: 'a', action: 'skipped (args is not an array)' }]);
    expect(serversOf(out)['a']).toEqual({ command: 'node', args: '--port 8080' });
  });

  it('never replaces a present-but-invalid mcpServers with an empty object', () => {
    const bad = { mcpServers: ['not', 'an', 'object'] } as unknown as McpConfigJson;
    const { config: out, outcomes } = unwrapMcpConfig(bad);
    expect(outcomes).toEqual([]);
    expect(out).toEqual(bad);
  });
});

describe('countWrapped, which is what doctor reports', () => {
  // A real, existing `index.js` — `countWrapped` now checks that a wrapper's
  // recorded entry file still exists, so a fixture path like `/x/dist/index.js`
  // (used everywhere else in this file, where existence never mattered) would
  // wrongly count as stale here.
  const entryDir = mkdtempSync(join(tmpdir(), 'stroq-mcp-entry-'));
  const realEntry = join(entryDir, 'index.js');
  writeFileSync(realEntry, '');
  const realOpts: WrapOptions = { ...opts, entryArgv: [realEntry] };

  it('counts wrapped stdio entries and ignores HTTP ones', () => {
    const wrapped = wrapMcpConfig(
      config({ a: { command: 'x' }, b: { command: 'y' }, remote: { url: 'https://x.example' } }),
      realOpts,
    );
    expect(countWrapped(wrapped.config)).toEqual({ wrapped: 2, stdio: 2, stale: 0 });
    // Unwrapping puts both stdio entries back, so none is behind the proxy any more.
    expect(countWrapped(unwrapMcpConfig(wrapped.config).config)).toEqual({
      wrapped: 0,
      stdio: 2,
      stale: 0,
    });
    expect(countWrapped({ mcpServers: {} })).toEqual({ wrapped: 0, stdio: 0, stale: 0 });
  });

  it('does not count a wrapper whose recorded entry file no longer exists', () => {
    // Both entries are recognisably wrapped, but their recorded entry path is gone —
    // an upgrade or uninstall that removed the old path without re-running `init`.
    const wrapped = wrapMcpConfig(config({ a: { command: 'x' }, b: { command: 'y' } }), {
      ...opts,
      entryArgv: ['/does/not/exist/index.js'],
    });
    expect(countWrapped(wrapped.config)).toEqual({ wrapped: 0, stdio: 2, stale: 2 });
  });
});

describe('reading a real file', () => {
  it('reads a missing file as an empty object rather than throwing', () => {
    expect(readMcpConfig(join(mkdtempSync(join(tmpdir(), 'stroq-mcp-cfg-')), 'none.json'))).toEqual(
      {},
    );
  });
});
