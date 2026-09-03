import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  POST_MATCHER,
  PRE_MATCHER,
  hookCommand,
  installHooks,
  isStroqHandler,
  mergeHooks,
  readSettings,
  settingsPath,
} from '../../src/commands/init.js';

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
});
