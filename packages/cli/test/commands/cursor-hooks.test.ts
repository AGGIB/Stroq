import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CURSOR_HOOKS_VERSION,
  cursorEntry,
  cursorHooksPath,
  installCursorHooks,
  isStroqCursorHook,
  mergeCursorHooks,
  readCursorHooks,
  type CursorHooksJson,
} from '../../src/commands/cursor-hooks.js';

const cmd = '"/usr/bin/node" "/x/index.js" hook cursor';
const commandsOf = (settings: CursorHooksJson, event: string) =>
  (settings.hooks?.[event] ?? []).map((e) => e.command);

describe('cursorEntry', () => {
  it('fails closed only where a deny stops something', () => {
    expect(cursorEntry('beforeShellExecution', cmd)).toEqual({
      command: cmd,
      failClosed: true,
      timeout: 15,
    });
    expect(cursorEntry('beforeMCPExecution', cmd)).toEqual({
      command: cmd,
      failClosed: true,
      timeout: 15,
    });
    expect(cursorEntry('beforeReadFile', cmd)).toEqual({ command: cmd, timeout: 15 });
    expect(cursorEntry('afterShellExecution', cmd)).toEqual({ command: cmd, timeout: 15 });
    expect(cursorEntry('afterMCPExecution', cmd)).toEqual({ command: cmd, timeout: 15 });
    expect(cursorEntry('afterFileEdit', cmd)).toEqual({ command: cmd, timeout: 15 });
  });
});

describe('mergeCursorHooks', () => {
  it('writes version 1 and one entry per event into empty settings', () => {
    const merged = mergeCursorHooks({}, cmd);
    expect(merged.version).toBe(CURSOR_HOOKS_VERSION);
    expect(Object.keys(merged.hooks ?? {})).toEqual([
      'beforeShellExecution',
      'afterShellExecution',
      'beforeMCPExecution',
      'afterMCPExecution',
      'beforeReadFile',
      'afterFileEdit',
    ]);
    expect(commandsOf(merged, 'beforeShellExecution')).toEqual([cmd]);
    expect(merged.hooks?.['beforeShellExecution']?.[0]?.failClosed).toBe(true);
    expect(merged.hooks?.['afterFileEdit']?.[0]?.failClosed).toBeUndefined();
  });

  it('preserves foreign hooks, foreign events and other keys, and is idempotent', () => {
    const existing: CursorHooksJson = {
      version: 1,
      telemetry: false,
      hooks: {
        beforeShellExecution: [{ command: 'echo hi', timeout: 5 }],
        beforeSubmitPrompt: [{ command: 'echo prompt', timeout: 5 }],
      },
    };
    const once = mergeCursorHooks(existing, cmd);
    const twice = mergeCursorHooks(once, cmd);
    expect(twice['telemetry']).toBe(false);
    expect(commandsOf(twice, 'beforeShellExecution')).toEqual(['echo hi', cmd]);
    expect(commandsOf(twice, 'beforeSubmitPrompt')).toEqual(['echo prompt']);
    expect(commandsOf(twice, 'afterMCPExecution')).toEqual([cmd]);
  });

  it('replaces an older stroq entry and leaves the Claude Code one alone', () => {
    const old = mergeCursorHooks({}, '"/old/node" "/old/index.js" hook cursor');
    const withClaude: CursorHooksJson = {
      ...old,
      hooks: {
        ...old.hooks,
        beforeShellExecution: [
          ...(old.hooks?.['beforeShellExecution'] ?? []),
          { command: '"/n" "/e.js" hook claude-code', timeout: 15 },
        ],
      },
    };
    const updated = mergeCursorHooks(withClaude, cmd);
    expect(commandsOf(updated, 'beforeShellExecution')).toEqual([
      '"/n" "/e.js" hook claude-code',
      cmd,
    ]);
    expect(isStroqCursorHook({ command: cmd })).toBe(true);
    expect(isStroqCursorHook({ command: '"/n" "/e.js" hook claude-code' })).toBe(false);
    expect(isStroqCursorHook({ command: 'echo hi' })).toBe(false);
  });

  it('replaces a malformed non-array event value instead of throwing', () => {
    const malformed = { hooks: { beforeReadFile: 'nope' } } as unknown as CursorHooksJson;
    expect(commandsOf(mergeCursorHooks(malformed, cmd), 'beforeReadFile')).toEqual([cmd]);
  });
});

describe('cursor hooks files', () => {
  it('computes project and user paths', () => {
    expect(cursorHooksPath('project', '/w')).toBe('/w/.cursor/hooks.json');
    expect(cursorHooksPath('user')).toMatch(/\.cursor\/hooks\.json$/);
  });

  it('reads missing or empty files as {} and installs hooks creating directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-cursor-init-'));
    const file = cursorHooksPath('project', dir);
    expect(readCursorHooks(file)).toEqual({});
    mkdirSync(join(dir, '.cursor'));
    writeFileSync(file, '');
    expect(readCursorHooks(file)).toEqual({});
    installCursorHooks(file, cmd);
    expect(existsSync(file)).toBe(true);
    const written = JSON.parse(readFileSync(file, 'utf8')) as CursorHooksJson;
    expect(written.version).toBe(1);
    expect(commandsOf(written, 'beforeMCPExecution')).toEqual([cmd]);
  });

  it('throws a descriptive error when hooks.json has invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-cursor-init-'));
    mkdirSync(join(dir, '.cursor'));
    const file = cursorHooksPath('project', dir);
    writeFileSync(file, '{ not json');
    expect(() => readCursorHooks(file)).toThrow(/cannot parse/);
  });
});
