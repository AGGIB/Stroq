import { afterEach, describe, expect, it, vi } from 'vitest';
import { readClaudeVersion, requireClaudeVersion } from '../../src/task/version.js';
const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: probe }));
afterEach(() => vi.resetAllMocks());

describe('Claude task version preflight', () => {
  it.each(['2.1.248 (Claude Code)', '2.1.271 (Claude Code)', '2.2.0', '3.0.0'])(
    'accepts supported version %s',
    (version) => {
      expect(() => requireClaudeVersion(version)).not.toThrow();
    },
  );
  it.each(['2.1.247', '2.0.999', '1.9.999', 'unknown', '2.1.248-beta', null])(
    'refuses unsupported or unreadable version %s',
    (version) => {
      expect(() => requireClaudeVersion(version)).toThrow('Claude Code 2.1.248 or later');
    },
  );
  it('probes only --version with bounded output/time and a filtered environment', () => {
    probe.mockReturnValue({ status: 0, stdout: '2.1.271 (Claude Code)\n' });
    expect(
      readClaudeVersion('/trusted/claude', {
        PATH: '/bin',
        NODE_OPTIONS: 'evil',
        ANTHROPIC_API_KEY: 'private',
        claude_code_oauth_token: 'private-token',
      }),
    ).toBe('2.1.271 (Claude Code)');
    expect(probe).toHaveBeenCalledWith(
      '/trusted/claude',
      ['--version'],
      expect.objectContaining({
        timeout: 5000,
        maxBuffer: 4096,
        env: { PATH: '/bin' },
        windowsHide: true,
      }),
    );
    probe.mockReturnValue({ status: 1 });
    expect(readClaudeVersion('/trusted/claude', {})).toBeNull();
    probe.mockImplementation(() => {
      throw new Error('not executable');
    });
    expect(readClaudeVersion('/trusted/claude', {})).toBeNull();
  });
});
