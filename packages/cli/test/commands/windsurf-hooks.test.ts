import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  installWindsurfHooks,
  isStroqWindsurfHook,
  isStroqWindsurfHooks,
  mergeWindsurfHooks,
  readWindsurfHooks,
  windsurfEntry,
  windsurfHooksPath,
  type WindsurfHooksJson,
} from '../../src/commands/windsurf-hooks.js';

const cmd = '"/usr/bin/node" "/x/index.js" hook windsurf';
const commandsOf = (settings: WindsurfHooksJson, event: string) =>
  (settings.hooks?.[event] ?? []).map((e) => e.command);

describe('windsurfEntry', () => {
  it('writes the three keys Stroq needs and nothing Windsurf does not have', () => {
    expect(windsurfEntry(cmd)).toEqual({
      command: cmd,
      // `&` is PowerShell's call operator: without it a quoted path is echoed, not run.
      powershell: `& ${cmd}`,
      // So the block reason and the taint warning are visible in the Cascade UI. On
      // an allow Stroq prints nothing, so nothing shows.
      show_output: true,
    });
    // No `working_directory`: its default is the workspace root, which is exactly
    // the trusted directory the adapter's policy cwd relies on. No `timeout` either
    // — the format has no such key — and no `version`.
    const json = JSON.stringify(windsurfEntry(cmd));
    expect(json).not.toContain('working_directory');
    expect(json).not.toContain('timeout');
    expect(json).not.toContain('version');
  });

  it('recognises its own entry by the command suffix init writes', () => {
    expect(isStroqWindsurfHook(windsurfEntry(cmd))).toBe(true);
    expect(isStroqWindsurfHook({ command: 'echo hi' })).toBe(false);
    // A suffix that only looks similar is not ours; nor is a phase argument, which
    // Windsurf's entries never carry.
    expect(isStroqWindsurfHook({ command: '"/n" "/e.js" hook windsurf pre' })).toBe(false);
    expect(isStroqWindsurfHook({ command: '"/n" "/e.js" hook copilot' })).toBe(false);
  });
});

describe('mergeWindsurfHooks', () => {
  it('writes one entry per installed event into an empty file, and no version key', () => {
    const merged = mergeWindsurfHooks({}, cmd);
    expect(Object.keys(merged.hooks ?? {})).toEqual([
      'pre_read_code',
      'post_read_code',
      'pre_write_code',
      'pre_run_command',
      'pre_mcp_tool_use',
      'post_mcp_tool_use',
    ]);
    expect(commandsOf(merged, 'pre_run_command')).toEqual([cmd]);
    // Windsurf's format has no version field; writing one would be inventing a key.
    expect(merged['version']).toBeUndefined();
  });

  it('preserves foreign entries, foreign events and other keys, and is idempotent', () => {
    const existing: WindsurfHooksJson = {
      telemetry: false,
      hooks: {
        pre_run_command: [{ command: 'echo hi' }],
        // An event Stroq deliberately does not install on: it must survive untouched.
        pre_user_prompt: [{ command: 'echo prompt' }],
      },
    };
    const once = mergeWindsurfHooks(existing, cmd);
    const twice = mergeWindsurfHooks(once, cmd);
    expect(twice['telemetry']).toBe(false);
    expect(commandsOf(twice, 'pre_run_command')).toEqual(['echo hi', cmd]);
    expect(commandsOf(twice, 'pre_user_prompt')).toEqual(['echo prompt']);
    expect(commandsOf(twice, 'post_mcp_tool_use')).toEqual([cmd]);
  });

  it('replaces an older Stroq entry rather than stacking a second one', () => {
    const old = mergeWindsurfHooks({}, '"/old/node" "/old/index.js" hook windsurf');
    const merged = mergeWindsurfHooks(old, cmd);
    expect(commandsOf(merged, 'pre_write_code')).toEqual([cmd]);
    expect(JSON.stringify(merged)).not.toContain('/old/node');
  });

  it('survives a hand-mangled file without throwing', () => {
    for (const hooks of [
      { pre_run_command: 'nope' },
      { pre_run_command: 7 },
      { pre_run_command: [null, 'x'] },
    ]) {
      const merged = mergeWindsurfHooks({ hooks } as unknown as WindsurfHooksJson, cmd);
      expect(commandsOf(merged, 'pre_run_command')).toContain(cmd);
    }
  });

  it('drops a hooks value that is not a plain object, rather than fanning it into numeric keys', () => {
    for (const hooks of ['not an object', ['array', 'shaped']]) {
      const merged = mergeWindsurfHooks({ hooks } as unknown as WindsurfHooksJson, cmd);
      // `{ ...hooks, ...ours }` would otherwise spread a string or an array into
      // "0", "1", … keys alongside the six real events — not user content worth
      // keeping, and not a shape any reader of this file expects.
      expect(Object.keys(merged.hooks ?? {}).every((key) => !/^\d+$/.test(key))).toBe(true);
      expect(commandsOf(merged, 'pre_run_command')).toEqual([cmd]);
    }
  });
});

describe('isStroqWindsurfHooks', () => {
  it('is true only when all six events carry a Stroq entry', () => {
    // A half-install is not partial protection: a `pre` without its `post` never
    // taints, a `post` without its `pre` never blocks.
    const full = mergeWindsurfHooks({}, cmd);
    expect(isStroqWindsurfHooks(full)).toBe(true);
    const half = { hooks: { ...full.hooks, post_mcp_tool_use: [{ command: 'echo hi' }] } };
    expect(isStroqWindsurfHooks(half)).toBe(false);
    expect(isStroqWindsurfHooks({})).toBe(false);
  });

  it('says false for anything that is not a hooks object', () => {
    for (const json of [null, 'nope', 7, [], { hooks: 'nope' }, { hooks: { pre_read_code: 7 } }])
      expect(isStroqWindsurfHooks(json), JSON.stringify(json) ?? 'undefined').toBe(false);
  });
});

describe('windsurfHooksPath', () => {
  it('is the workspace file for a project and the Windsurf IDE file for a user', () => {
    expect(windsurfHooksPath('project', '/w')).toBe('/w/.windsurf/hooks.json');
    // `~/.codeium/windsurf/hooks.json` is the Windsurf IDE's user file. The JetBrains
    // plugin reads `~/.codeium/hooks.json`, which `init` deliberately does not write.
    expect(windsurfHooksPath('user', '/w')).toMatch(/\.codeium\/windsurf\/hooks\.json$/);
  });
});

describe('installWindsurfHooks', () => {
  it('creates the directory, writes the file, and rewrites it identically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-windsurf-init-'));
    const file = windsurfHooksPath('project', dir);
    expect(readWindsurfHooks(file)).toEqual({});
    installWindsurfHooks(file, cmd);
    expect(existsSync(file)).toBe(true);
    const first = readFileSync(file, 'utf8');
    installWindsurfHooks(file, cmd);
    expect(readFileSync(file, 'utf8')).toBe(first);
    expect(isStroqWindsurfHooks(readWindsurfHooks(file))).toBe(true);
  });

  it('keeps a foreign hook that was already in the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-windsurf-init-'));
    const file = windsurfHooksPath('project', dir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ "hooks": { "pre_run_command": [{ "command": "echo hi" }] } }');
    const merged = installWindsurfHooks(file, cmd);
    expect(commandsOf(merged, 'pre_run_command')).toEqual(['echo hi', cmd]);
  });

  it('throws a descriptive error when the file exists but is not JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-windsurf-init-'));
    const file = windsurfHooksPath('project', dir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ not json');
    expect(() => readWindsurfHooks(file)).toThrow(/cannot parse/);
  });
});
