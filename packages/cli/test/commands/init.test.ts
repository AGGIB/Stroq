import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  POST_MATCHER,
  PRE_MATCHER,
  hookCommand,
  installHooks,
  isStroqHandler,
  mergeHooks,
  readSettings,
  runInit,
  settingsPath,
} from '../../src/commands/init.js';
import { cursorHooksPath } from '../../src/commands/cursor-hooks.js';

describe('hookCommand', () => {
  it('quotes node and the entry file', () => {
    expect(hookCommand('/usr/bin/node', '/opt/stroq/dist/index.js')).toBe(
      '"/usr/bin/node" "/opt/stroq/dist/index.js" hook claude-code',
    );
  });
  it('adds the tsx loader for a TypeScript entry', () => {
    expect(hookCommand('/usr/bin/node', '/w/src/index.ts')).toBe(
      '"/usr/bin/node" --import tsx "/w/src/index.ts" hook claude-code',
    );
  });
});

describe('mergeHooks', () => {
  const cmd = '"/usr/bin/node" "/x/index.js" hook claude-code';
  it('adds PreToolUse and PostToolUse groups to empty settings', () => {
    const merged = mergeHooks({}, cmd);
    expect(merged.hooks?.['PreToolUse']).toEqual([
      { matcher: PRE_MATCHER, hooks: [{ type: 'command', command: cmd, timeout: 15 }] },
    ]);
    expect(merged.hooks?.['PostToolUse']?.[0]?.matcher).toBe(POST_MATCHER);
  });
  it('preserves foreign hooks and other settings, and is idempotent', () => {
    const existing = {
      permissions: { allow: ['Bash(ls *)'] },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command' as const, command: 'echo hi', timeout: 5 }],
          },
        ],
      },
    };
    const once = mergeHooks(existing, cmd);
    const twice = mergeHooks(once, cmd);
    expect(twice.permissions).toEqual({ allow: ['Bash(ls *)'] });
    expect(twice.hooks?.['PreToolUse']?.map((g) => g.hooks.map((h) => h.command))).toEqual([
      ['echo hi'],
      [cmd],
    ]);
    expect(twice.hooks?.['PostToolUse']).toHaveLength(1);
  });
  it('replaces an older stroq command with the new one', () => {
    const old = mergeHooks({}, '"/old/node" "/old/index.js" hook claude-code');
    const updated = mergeHooks(old, cmd);
    const commands = updated.hooks?.['PreToolUse']?.flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toEqual([cmd]);
    expect(isStroqHandler({ type: 'command', command: cmd, timeout: 15 })).toBe(true);
    expect(isStroqHandler({ type: 'command', command: 'echo hi', timeout: 15 })).toBe(false);
  });
  it('preserves a malformed hook group lacking a hooks array, and stays idempotent', () => {
    const malformed = { hooks: { PreToolUse: [{ matcher: 'Bash' }] } } as unknown as Parameters<
      typeof mergeHooks
    >[0];
    const once = mergeHooks(malformed, cmd);
    expect(once.hooks?.['PreToolUse']).toEqual([
      { matcher: 'Bash' },
      { matcher: PRE_MATCHER, hooks: [{ type: 'command', command: cmd, timeout: 15 }] },
    ]);
    const twice = mergeHooks(once, cmd);
    expect(twice.hooks?.['PreToolUse']).toEqual([
      { matcher: 'Bash' },
      { matcher: PRE_MATCHER, hooks: [{ type: 'command', command: cmd, timeout: 15 }] },
    ]);
  });
});

describe('settings files', () => {
  it('computes project and user paths', () => {
    expect(settingsPath('project', '/w')).toBe('/w/.claude/settings.json');
    expect(settingsPath('user')).toMatch(/\.claude\/settings\.json$/);
  });
  it('reads missing or empty files as {} and installs hooks creating directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-init-'));
    const file = join(dir, '.claude', 'settings.json');
    expect(readSettings(file)).toEqual({});
    mkdirSync(join(dir, '.claude'));
    writeFileSync(file, '');
    expect(readSettings(file)).toEqual({});
    installHooks(file, '"/n" "/e.js" hook claude-code');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).hooks.PostToolUse).toHaveLength(1);
  });
  it('throws a descriptive error when the settings file has invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-init-'));
    mkdirSync(join(dir, '.claude'));
    const file = join(dir, '.claude', 'settings.json');
    writeFileSync(file, '{ not json');
    expect(() => readSettings(file)).toThrow(/cannot parse/);
  });
});

function capture(): { readonly lines: string[]; readonly restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.cwd();
  try {
    process.chdir(dir);
    return await fn();
  } finally {
    process.chdir(original);
  }
}

describe('hookCommand for cursor', () => {
  it('ends with the agent name, which is how init finds its own entries', () => {
    expect(hookCommand('/usr/bin/node', '/opt/stroq/dist/index.js', 'cursor')).toBe(
      '"/usr/bin/node" "/opt/stroq/dist/index.js" hook cursor',
    );
    expect(hookCommand('/usr/bin/node', '/w/src/index.ts', 'cursor')).toBe(
      '"/usr/bin/node" --import tsx "/w/src/index.ts" hook cursor',
    );
    expect(hookCommand('/usr/bin/node', '/opt/stroq/dist/index.js')).toMatch(/ hook claude-code$/);
  });
});

describe('runInit --agent', () => {
  it('writes .cursor/hooks.json for the project and is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-init-agent-'));
    const out = capture();
    const code = await inDir(dir, () => runInit(['--agent', 'cursor']));
    out.restore();
    expect(code).toBe(0);
    const file = cursorHooksPath('project', dir);
    expect(out.lines.join('')).toContain(file);
    const first = readFileSync(file, 'utf8');
    expect(JSON.parse(first).hooks.beforeShellExecution).toHaveLength(1);
    expect(JSON.parse(first).hooks.beforeShellExecution[0].failClosed).toBe(true);

    const again = capture();
    await inDir(dir, () => runInit(['--agent', 'cursor']));
    again.restore();
    expect(readFileSync(file, 'utf8')).toBe(first);
  });

  it('prints the merged file and writes nothing with --dry-run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-init-agent-'));
    const out = capture();
    const code = await inDir(dir, () => runInit(['--agent', 'cursor', '--dry-run']));
    out.restore();
    expect(code).toBe(0);
    expect(JSON.parse(out.lines.join('')).hooks.afterFileEdit).toHaveLength(1);
    expect(existsSync(cursorHooksPath('project', dir))).toBe(false);
  });

  it('still installs Claude Code hooks by default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-init-agent-'));
    const out = capture();
    const code = await inDir(dir, () => runInit([]));
    out.restore();
    expect(code).toBe(0);
    expect(existsSync(settingsPath('project', dir))).toBe(true);
    expect(existsSync(cursorHooksPath('project', dir))).toBe(false);
  });

  it('rejects an unknown agent', async () => {
    const out = capture();
    const code = await runInit(['--agent', 'copilot']);
    out.restore();
    expect(code).toBe(1);
    expect(out.lines.join('')).toBe('unknown agent "copilot" (supported: claude-code, cursor)\n');
  });
});
