import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mayDraw } from '../../src/commands/init-args.js';
import { runInit } from '../../src/commands/init.js';

/**
 * `--strict` belongs to the MCP proxy. On any other agent there is no proxy to make
 * strict, so the flag has to be refused out loud, not accepted and ignored: a user who
 * typed it believes something is stricter than it is.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stroq-init-strict-agent-'));
  process.env['HOME'] = join(dir, 'fakehome');
  process.env['USERPROFILE'] = join(dir, 'fakehome');
  process.env['STROQ_HOME'] = join(dir, 'stroq-home');
  mkdirSync(process.env['HOME'], { recursive: true });
});

async function init(...args: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const code = await runInit(args, { platform: 'linux' });
    return { code, out: lines.join('') };
  } finally {
    process.chdir(cwd);
    spy.mockRestore();
  }
}

describe('stroq init --strict for an agent that is not the MCP proxy', () => {
  it.each(['claude-code', 'cursor', 'codex', 'copilot', 'windsurf', 'antigravity'])(
    'is refused for %s, and nothing is written',
    async (agent) => {
      const before = readdirSync(dir).sort();
      const { code, out } = await init('--agent', agent, '--strict');
      expect(code).toBe(1);
      expect(out).toContain('--strict');
      expect(out).toContain('--agent mcp');
      expect(readdirSync(dir).sort()).toEqual(before);
      expect(existsSync(join(dir, '.claude'))).toBe(false);
    },
  );

  it('is refused when no agent is named, since that is claude-code', async () => {
    const { code, out } = await init('--strict');
    expect(code).toBe(1);
    expect(out).toContain('--agent mcp');
  });

  it('is not turned into a first-run screen: the question would be asked about a flag that is refused', () => {
    expect(mayDraw(['--strict'])).toBe(false);
    expect(mayDraw(['--agent', 'cursor', '--strict'])).toBe(false);
    expect(mayDraw(['--user'])).toBe(true);
  });

  it('is still accepted for the MCP proxy', async () => {
    const config = join(dir, 'mcp.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(config, JSON.stringify({ mcpServers: { a: { command: 'srv' } } }));
    const { code, out } = await init('--agent', 'mcp', '--config', config, '--strict');
    expect(code).toBe(0);
    expect(out).toContain('--strict is ON');
  });
});
