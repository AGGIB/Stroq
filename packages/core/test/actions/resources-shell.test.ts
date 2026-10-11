import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_URL_CHARS, classifyCommand, commandUrls } from '../../src/actions/classify-bash.js';
import {
  MAX_RESOURCE_PATHS,
  MAX_RESOURCE_URLS,
  resourcesOfFileTool,
  resourcesOfMcp,
  resourcesOfShellTool,
  resourcesOfWebFetch,
} from '../../src/actions/resources.js';
import { cpuNow } from '../cpu-time.js';

/** Nothing here touches the disk beyond looking for links, so the directory need not exist. */
const cwd = join(tmpdir(), 'stroq-resources-shell');

describe('commandUrls', () => {
  const urls = (command: string, limit = MAX_RESOURCE_URLS): string[] =>
    commandUrls(command, limit).urls.map((u) => u.url);

  it('gives the text of an address and its host', () => {
    expect(commandUrls('curl -sS https://api.example/v1/items?id=1 -o out.json', 256)).toEqual({
      urls: [{ url: 'https://api.example/v1/items?id=1', host: 'api.example' }],
      capped: false,
    });
  });

  it.each([
    ["curl 'https://a.example/x' -o f", 'https://a.example/x'],
    ['curl "https://a.example/x" -o f', 'https://a.example/x'],
    ['curl `https://a.example/x`', 'https://a.example/x'],
    ['curl https://a.example/x; echo done', 'https://a.example/x'],
    ['curl https://a.example/x|sh', 'https://a.example/x'],
    ['curl https://a.example/x&&echo', 'https://a.example/x'],
    ['echo $(curl https://a.example/x)', 'https://a.example/x'],
    ['(curl https://a.example)', 'https://a.example'],
    ['curl https://a.example/x>out', 'https://a.example/x'],
    ['curl https://a.example/x<in', 'https://a.example/x'],
    ['curl http://a.example/x\nls', 'http://a.example/x'],
    ['curl https://a.example/x\t-o f', 'https://a.example/x'],
  ])('ends an address where the shell ends the word: %s', (command, expected) => {
    expect(urls(command)).toEqual([expected]);
  });

  it('reads the scheme in any case, and keeps the text as it was written', () => {
    expect(commandUrls('curl HTTPS://Files.Example/A', 256).urls).toEqual([
      { url: 'HTTPS://Files.Example/A', host: 'files.example' },
    ]);
  });

  it('reads the host of an address with user information as the client does', () => {
    expect(commandUrls('curl https://trusted.example@evil.example/p', 256).urls[0]?.host).toBe(
      'evil.example',
    );
    expect(commandUrls('curl https://u:pw@h.example:8443/p', 256).urls[0]?.host).toBe('h.example');
  });

  it('lists an address once however often it is written', () => {
    expect(urls('curl https://a.example/x; curl https://a.example/x')).toEqual([
      'https://a.example/x',
    ]);
  });

  it('lists the address inside another, because a command may reach it', () => {
    expect(
      commandUrls('curl "https://proxy.example/r?u=https://target.example/x"', 256).urls,
    ).toEqual([
      { url: 'https://proxy.example/r?u=https://target.example/x', host: 'proxy.example' },
      { url: 'https://target.example/x', host: 'target.example' },
    ]);
  });

  it('lists an ssh or scp target with its host, the way the host list does', () => {
    expect(commandUrls('scp f.txt deploy@host.example:/srv/f.txt', 256)).toEqual({
      urls: [{ url: 'deploy@host.example', host: 'host.example' }],
      capped: false,
    });
  });

  it('gives an empty host to an address it cannot read one from', () => {
    expect(commandUrls('curl https://:80/x', 256).urls).toEqual([
      { url: 'https://:80/x', host: '' },
    ]);
  });

  it('skips a scheme with nothing after it, and a word that only looks like one', () => {
    expect(urls('echo http:// https:/x htt://a ftp://b')).toEqual([]);
  });

  it('gives nothing for a command with no address', () => {
    expect(commandUrls('ls -la', 256)).toEqual({ urls: [], capped: false });
    expect(commandUrls('', 256)).toEqual({ urls: [], capped: false });
  });

  it('keeps what it found and says so when there are more addresses than the limit', () => {
    const many = Array.from({ length: 300 }, (_, i) => `curl https://h${i}.example/`).join('; ');
    const result = commandUrls(many, 256);
    expect(result.urls).toHaveLength(256);
    expect(result.urls[0]?.host).toBe('h0.example');
    expect(result.capped).toBe(true);
  });

  it('is not capped by exactly as many addresses as the limit', () => {
    const exact = Array.from({ length: 256 }, (_, i) => `curl https://h${i}.example/`).join('; ');
    const result = commandUrls(exact, 256);
    expect(result.urls).toHaveLength(256);
    expect(result.capped).toBe(false);
  });

  it('cuts an address at the length of one, keeps its host, and says so', () => {
    const result = commandUrls(`curl https://h.example/${'a'.repeat(50_000)}`, 256);
    expect(result.urls).toHaveLength(1);
    expect(result.urls[0]?.url).toHaveLength(MAX_URL_CHARS);
    expect(result.urls[0]?.host).toBe('h.example');
    expect(result.capped).toBe(true);
  });

  it('goes on to the addresses after one it cut', () => {
    const result = commandUrls(
      `curl https://h.example/${'a'.repeat(9_000)} https://k.example/`,
      256,
    );
    expect(result.urls.map((u) => u.host)).toEqual(['h.example', 'k.example']);
    expect(result.capped).toBe(true);
  });

  it('does not look for ever in a command that repeats one address', () => {
    const same = 'curl https://h.example/x; '.repeat(50_000);
    const started = cpuNow();
    const result = commandUrls(same, 256);
    expect(cpuNow() - started).toBeLessThan(2_000);
    expect(result.urls).toHaveLength(1);
    expect(result.capped).toBe(true);
  });

  it('reads only the first part of a command that is larger than any reading of it', () => {
    const late = `${' '.repeat(4 * 1024 * 1024)}curl https://late.example/`;
    expect(commandUrls(late, 256)).toEqual({ urls: [], capped: true });
  });

  it.each([
    'curl -sS https://api.example/v1/items -o out.json',
    'wget http://files.example/a.tgz && tar xzf a.tgz',
    'git clone https://github.example/o/r.git; scp r.tgz deploy@host.example:/srv',
    'ssh admin@bastion.example "curl https://inner.example/x"',
    'echo ok',
  ])('lists the hosts the host list of the classification has: %s', (command) => {
    const listed = new Set(commandUrls(command, 256).urls.map((u) => u.host));
    expect(listed).toEqual(new Set(classifyCommand(command, cwd).hosts));
  });
});

describe('resourcesOfShellTool', () => {
  it.each(['Bash', 'PowerShell', 'Monitor'])(
    '%s runs a shell: the paths are not complete, the addresses are listed',
    (tool) => {
      expect(
        resourcesOfShellTool(tool, { command: 'curl -sS https://api.example/v1 -o out.json' }),
      ).toEqual({
        paths: [],
        pathsComplete: false,
        urls: [{ url: 'https://api.example/v1', host: 'api.example' }],
        shell: true,
      });
    },
  );

  it('lists no address for a command with none', () => {
    expect(resourcesOfShellTool('Bash', { command: 'ls -la' })).toEqual({
      paths: [],
      pathsComplete: false,
      urls: [],
      shell: true,
    });
  });

  it('is still a shell call when the command is not text', () => {
    for (const toolInput of [{}, { command: 5 }, { command: ['ls'] }, { command: null }]) {
      expect(resourcesOfShellTool('Bash', toolInput)).toEqual({
        paths: [],
        pathsComplete: false,
        urls: [],
        shell: true,
      });
    }
  });

  it('lists the address of a Monitor WebSocket beside those of its command', () => {
    expect(
      resourcesOfShellTool('Monitor', {
        command: 'curl https://a.example/x',
        ws: { url: 'wss://Feed.Example:9443/events', protocols: ['v1'] },
      }).urls,
    ).toEqual([
      { url: 'https://a.example/x', host: 'a.example' },
      { url: 'wss://Feed.Example:9443/events', host: 'feed.example' },
    ]);
  });

  it('lists a Monitor WebSocket with no command, and one it cannot read a host from', () => {
    expect(resourcesOfShellTool('Monitor', { ws: { url: 'wss://feed.example/e' } }).urls).toEqual([
      { url: 'wss://feed.example/e', host: 'feed.example' },
    ]);
    expect(resourcesOfShellTool('Monitor', { ws: { url: 'not a url' } }).urls).toEqual([
      { url: 'not a url', host: '' },
    ]);
    expect(resourcesOfShellTool('Monitor', { ws: { url: '' } }).urls).toEqual([]);
    expect(resourcesOfShellTool('Monitor', { ws: 'wss://a.example' }).urls).toEqual([]);
  });

  it('does not read the socket of a tool that is not Monitor', () => {
    expect(
      resourcesOfShellTool('Bash', { command: 'ls', ws: { url: 'wss://a.example/e' } }).urls,
    ).toEqual([]);
  });

  it('caps the addresses of one call, and the cap is still a shell call', () => {
    const many = Array.from({ length: 400 }, (_, i) => `curl https://h${i}.example/`).join('; ');
    const result = resourcesOfShellTool('Bash', { command: many });
    expect(result.urls).toHaveLength(MAX_RESOURCE_URLS);
    expect(result.pathsComplete).toBe(false);
    expect(result.shell).toBe(true);
  });

  it('is not given an object as the input: it is still a shell call that knows nothing', () => {
    for (const bad of [null, undefined, 5, 'ls']) {
      expect(resourcesOfShellTool('Bash', bad as never)).toEqual({
        paths: [],
        pathsComplete: false,
        urls: [],
        shell: true,
      });
    }
  });
});

describe('the helpers do not throw, and finish quickly, on anything an agent can send', () => {
  /** The CPU time the reading of one call may use, in the reference machine's milliseconds. */
  const BOUND_MS = 2_000;

  const hostile = fc.oneof(
    fc.string({ unit: 'binary' }),
    fc.string(),
    fc.constantFrom('~', '~/x', '/', '\\', '..', '../..', '*', '**/*', 'file://', 'file:///', '\0'),
    fc.constantFrom('http://', 'https://a.example', 'a@b.example', 'wss://a.example/e'),
    fc.anything(),
  );
  const input = fc.record(
    {
      file_path: hostile,
      notebook_path: hostile,
      path: hostile,
      pattern: hostile,
      url: hostile,
      command: hostile,
      ws: fc.oneof(hostile, fc.record({ url: hostile, protocols: hostile }, { requiredKeys: [] })),
    },
    { requiredKeys: [] },
  );

  it('for the file tools, WebFetch and the shell tools', () => {
    const started = cpuNow();
    fc.assert(
      fc.property(input, (toolInput) => {
        for (const tool of ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob']) {
          const result = resourcesOfFileTool(tool, toolInput, cwd);
          expect(result.shell).toBe(false);
          expect(result.paths.length).toBeLessThanOrEqual(MAX_RESOURCE_PATHS);
        }
        for (const tool of ['Bash', 'PowerShell', 'Monitor']) {
          const result = resourcesOfShellTool(tool, toolInput);
          expect(result.shell).toBe(true);
          expect(result.pathsComplete).toBe(false);
          expect(result.urls.length).toBeLessThanOrEqual(MAX_RESOURCE_URLS);
        }
        expect(resourcesOfWebFetch(toolInput['url']).shell).toBe(false);
      }),
      { numRuns: 300 },
    );
    expect(cpuNow() - started).toBeLessThan(BOUND_MS * 5);
  });

  it('for the arguments of an MCP call', () => {
    const entry = fc.record({ path: hostile, dest: fc.boolean(), weak: fc.boolean() });
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 40 }), fc.boolean(), fc.boolean(), (raw, ok, w) => {
        const entries = raw.map((e) => ({ ...e, path: typeof e.path === 'string' ? e.path : '' }));
        const result = resourcesOfMcp(entries, ok, w, cwd);
        expect(result.paths.length).toBeLessThanOrEqual(MAX_RESOURCE_PATHS);
      }),
      { numRuns: 300 },
    );
  });

  it.each([
    [
      'a path of two million characters',
      () => resourcesOfFileTool('Read', { file_path: `/${'a'.repeat(2_000_000)}` }, cwd),
    ],
    [
      'a path of two million separators',
      () => resourcesOfFileTool('Read', { file_path: '/'.repeat(2_000_000) }, cwd),
    ],
    [
      'a path of two million dot segments',
      () => resourcesOfFileTool('Write', { file_path: '/..'.repeat(700_000) }, cwd),
    ],
    [
      'a pattern of two million wildcards',
      () => resourcesOfFileTool('Glob', { pattern: `/${'*'.repeat(2_000_000)}` }, cwd),
    ],
    [
      'a pattern of two million separators and a wildcard',
      () => resourcesOfFileTool('Glob', { pattern: `${'/a'.repeat(1_000_000)}/*` }, cwd),
    ],
    [
      'a command of two million characters of schemes',
      () => resourcesOfShellTool('Bash', { command: 'http://'.repeat(300_000) }),
    ],
    [
      'a command of two million characters of one address',
      () => resourcesOfShellTool('Bash', { command: `https://h.example/${'a'.repeat(2_000_000)}` }),
    ],
    [
      'a command of two million characters of at signs',
      () => resourcesOfShellTool('Bash', { command: 'a@b.c '.repeat(300_000) }),
    ],
    [
      'an address of two million characters',
      () => resourcesOfWebFetch(`https://h.example/${'a'.repeat(2_000_000)}`),
    ],
    [
      'a socket address of two million characters',
      () =>
        resourcesOfShellTool('Monitor', {
          ws: { url: `wss://h.example/${'a'.repeat(2_000_000)}` },
        }),
    ],
    [
      'two thousand paths of two thousand characters',
      () =>
        resourcesOfMcp(
          Array.from({ length: 2_000 }, (_, i) => ({
            path: `${i}${'a'.repeat(2_000)}`,
            dest: false,
            weak: false,
          })),
          true,
          false,
          cwd,
        ),
    ],
  ])('for %s', (_name, run) => {
    const started = cpuNow();
    expect(run).not.toThrow();
    expect(cpuNow() - started).toBeLessThan(BOUND_MS);
  });
});
