import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mcpFindings, mcpSurface } from '../../src/exposure/mcp-surface.js';

const fixture = (): string => mkdtempSync(join(tmpdir(), 'stroq-mcp-'));

const writeProjectMcp = (cwd: string, servers: Record<string, unknown>): void => {
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
};

/**
 * A wrapped entry the way `stroq init --agent mcp` writes one: an entry-shaped path
 * that EXISTS, then `mcp --server <name> --client <client> -- <original argv>`.
 * `countWrapped` rejects anything looser, so a hand-shortened fixture would count as
 * unwrapped and the assertion below would pass for the wrong reason.
 */
const wrappedEntry = (cwd: string): Record<string, unknown> => {
  mkdirSync(join(cwd, 'dist'), { recursive: true });
  const entry = join(cwd, 'dist', 'index.js');
  writeFileSync(entry, '');
  return {
    command: 'node',
    args: [entry, 'mcp', '--server', 'x', '--client', 'claude-code', '--', 'node', 's.js'],
  };
};

describe('mcpSurface', () => {
  it('returns nothing when no client config exists', () => {
    expect(mcpSurface(fixture())).toHaveLength(0);
  });

  it('counts stdio servers and how many go through the proxy', () => {
    const cwd = fixture();
    writeProjectMcp(cwd, {
      plain: { command: 'node', args: ['server.js'] },
      wrapped: wrappedEntry(cwd),
    });
    const found = mcpSurface(cwd).find((s) => s.client === 'claude-code');
    expect(found?.stdio).toBe(2);
    expect(found?.wrapped).toBe(1);
  });

  it('counts http entries separately from stdio', () => {
    const cwd = fixture();
    writeProjectMcp(cwd, {
      remote: { url: 'https://example.com/mcp' },
      local: { command: 'node', args: ['s.js'] },
    });
    const found = mcpSurface(cwd).find((s) => s.client === 'claude-code');
    expect(found?.http).toBe(1);
    expect(found?.stdio).toBe(1);
  });

  it('skips a malformed config rather than throwing', () => {
    const cwd = fixture();
    writeFileSync(join(cwd, '.mcp.json'), '{ not json');
    expect(() => mcpSurface(cwd)).not.toThrow();
    expect(mcpSurface(cwd)).toHaveLength(0);
  });
});

describe('mcpFindings', () => {
  it('raises a high finding naming the unwrapped count', () => {
    const findings = mcpFindings([
      {
        client: 'claude-code',
        scope: 'project',
        file: '/p/.mcp.json',
        stdio: 3,
        wrapped: 1,
        http: 0,
      },
    ]);
    const unwrapped = findings.find((f) => f.class === 'mcp-unwrapped');
    expect(unwrapped?.severity).toBe('high');
    expect(unwrapped?.detail).toContain('2');
    expect(unwrapped?.fix).toBe('stroq init --agent mcp --client claude-code');
  });

  it('raises a medium finding for http servers the proxy cannot reach', () => {
    const findings = mcpFindings([
      { client: 'cursor', scope: 'user', file: '/h/.cursor/mcp.json', stdio: 0, wrapped: 0, http: 2 },
    ]);
    const http = findings.find((f) => f.class === 'mcp-http-unreachable');
    expect(http?.severity).toBe('medium');
    expect(http?.fix).toBeNull();
  });

  it('raises nothing when every stdio server is wrapped and there is no http', () => {
    expect(
      mcpFindings([
        {
          client: 'cursor',
          scope: 'user',
          file: '/h/.cursor/mcp.json',
          stdio: 2,
          wrapped: 2,
          http: 0,
        },
      ]),
    ).toHaveLength(0);
  });
});
