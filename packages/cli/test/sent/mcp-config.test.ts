import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMcpServers } from '../../src/sent/mcp-config.js';

/**
 * Whether an MCP server a session called runs on this machine or somewhere else, read from the
 * clients' own config files. Only `type`, `url` and `command` are read; the files here are made up.
 */

function machine(): { home: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), 'stroq-sent-mcp-'));
  const home = join(root, 'home');
  const project = join(root, 'work', 'app');
  mkdirSync(join(home, '.cursor'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(project, '.cursor'), { recursive: true });
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        linear: { type: 'http', url: 'https://mcp.linear.example/mcp', headers: { x: 'IGNORED' } },
        'local tools': { command: 'node', args: ['server.js'], env: { TOKEN: 'IGNORED' } },
      },
      projects: {
        [project]: { mcpServers: { tracker: { type: 'sse', url: 'https://tracker.example/sse' } } },
      },
      oauthAccount: { emailAddress: 'IGNORED' },
    }),
  );
  writeFileSync(
    join(project, '.mcp.json'),
    JSON.stringify({ mcpServers: { supabase: { command: 'npx', args: ['-y', 'x'] } } }),
  );
  writeFileSync(
    join(home, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { notes: { url: 'https://notes.example/mcp' } } }),
  );
  writeFileSync(
    join(home, '.codex', 'config.toml'),
    [
      'model = "x"',
      '[mcp_servers.docs]',
      'url = "https://docs.example/mcp"',
      '',
      '[mcp_servers."local-db"]',
      'command = "db-server"',
      'args = ["--port", "1"]',
    ].join('\n'),
  );
  return { home, project };
}

describe('loadMcpServers', () => {
  const { home, project } = machine();
  const servers = loadMcpServers({ home, projectDirs: [project] });

  it.each([
    ['mcp__linear__create_issue', 'linear', true, 'mcp.linear.example'],
    ['mcp__tracker__log', 'tracker', true, 'tracker.example'],
    ['mcp__notes__save', 'notes', true, 'notes.example'],
    ['mcp__docs__search', 'docs', true, 'docs.example'],
    ['mcp__local_tools__run', 'local_tools', false, null],
    ['mcp__supabase__execute_sql', 'supabase', false, null],
    ['mcp__local-db__query', 'local-db', false, null],
  ])('%s: server %s, remote %s, host %s', (tool, name, remote, host) => {
    const found = servers.lookup(tool);
    expect(found?.name).toBe(name);
    expect(found?.server).toEqual({ remote, host });
  });

  it('knows a claude.ai connector is remote without a config entry', () => {
    const found = servers.lookup('mcp__claude_ai_ClickUp__clickup_search');
    expect(found).toEqual({
      name: 'ClickUp',
      server: { remote: true, host: null },
      connector: true,
    });
  });

  it('says it does not know a server no config names', () => {
    expect(servers.lookup('mcp__unknown_thing__x')).toEqual({
      name: 'unknown_thing',
      server: null,
      connector: false,
    });
    expect(servers.lookup('Bash')).toBeNull();
  });

  it('reads nothing but the transport fields', () => {
    const kept = JSON.stringify([...servers.known.entries()]);
    expect(kept).toContain('mcp.linear.example');
    expect(kept).not.toContain('IGNORED');
  });

  it('is empty, not broken, on a machine with no MCP config', () => {
    const empty = mkdtempSync(join(tmpdir(), 'stroq-sent-mcp-empty-'));
    expect(
      loadMcpServers({ home: empty, projectDirs: [empty] }).lookup('mcp__a__b')?.server,
    ).toBeNull();
  });
});
