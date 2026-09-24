import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_HOOK_EVENTS,
  ANTIGRAVITY_HOOK_NAME,
  ANTIGRAVITY_HOOK_TIMEOUT_SECONDS,
  antigravityHooksPath,
  buildAntigravityHook,
  installAntigravityHooks,
  isStroqAntigravityHooks,
  mergeAntigravityHooks,
  readAntigravityHooks,
  type AntigravityHooksJson,
} from '../../src/commands/antigravity-hooks.js';

const cmd = '"/usr/bin/node" "/x/index.js" hook antigravity';
const ours = (json: AntigravityHooksJson) =>
  (json[ANTIGRAVITY_HOOK_NAME] ?? {}) as Record<string, unknown>;
const commandsIn = (json: AntigravityHooksJson): string[] =>
  JSON.stringify(ours(json)).match(/hook antigravity [a-z]+/g) ?? [];

describe('buildAntigravityHook', () => {
  it('is keyed by a hook NAME, which no other supported format is', () => {
    const built = buildAntigravityHook(cmd);
    expect(Object.keys(built)).toEqual(['enabled', ...ANTIGRAVITY_HOOK_EVENTS]);
    expect(ANTIGRAVITY_HOOK_EVENTS).toEqual(['PreToolUse', 'PostToolUse', 'PreInvocation']);
  });

  it('writes enabled: true explicitly, although true is the default', () => {
    // It is the one field that can switch Stroq off while the entries still look
    // installed, so writing it means re-running `init` repairs an `enabled: false`.
    expect(buildAntigravityHook(cmd).enabled).toBe(true);
  });

  it('gives the two tool events an empty matcher, which means every tool', () => {
    const built = buildAntigravityHook(cmd);
    for (const event of ['PreToolUse', 'PostToolUse'] as const) {
      // A matcher is a regex over the tool NAME, and Antigravity's hooks never reveal
      // an MCP server — so any list Stroq could write would be a list of the tools it
      // already knows about, and the MCP call it has never heard of would be the one
      // that skipped the hook.
      expect(built[event][0]?.matcher, event).toBe('');
      expect(built[event][0]?.hooks[0]?.timeout, event).toBe(ANTIGRAVITY_HOOK_TIMEOUT_SECONDS);
      expect(built[event][0]?.hooks[0]?.type, event).toBe('command');
    }
  });

  it('puts PreInvocation handlers directly under the event key, with no matcher group', () => {
    // The matcher is ignored for `PreInvocation`, and the handlers sit one level
    // higher than they do for the tool events. Writing a matcher group there would
    // be a hook that never runs.
    const built = buildAntigravityHook(cmd);
    expect(built.PreInvocation).toEqual([
      {
        type: 'command',
        command: `${cmd} preinvocation`,
        timeout: ANTIGRAVITY_HOOK_TIMEOUT_SECONDS,
      },
    ]);
  });

  it('gives each event its own phase, because the payloads do not name themselves', () => {
    expect(commandsIn({ [ANTIGRAVITY_HOOK_NAME]: buildAntigravityHook(cmd) })).toEqual([
      'hook antigravity pre',
      'hook antigravity post',
      'hook antigravity preinvocation',
    ]);
  });
});

describe('mergeAntigravityHooks', () => {
  it('owns one top-level key and leaves every other hook name untouched', () => {
    // Unlike Cursor's and Windsurf's per-event arrays, Antigravity's file is a map of
    // hook NAME to events — so there is nothing to merge inside Stroq's own entry,
    // and a user's hooks are a sibling key rather than a sibling array element.
    const existing: AntigravityHooksJson = {
      'my-linter-hook': { PostToolUse: [{ matcher: 'run_command', hooks: [] }] },
      telemetry: false,
    };
    const merged = mergeAntigravityHooks(existing, cmd);
    expect(merged['my-linter-hook']).toEqual(existing['my-linter-hook']);
    expect(merged['telemetry']).toBe(false);
    expect(isStroqAntigravityHooks(merged)).toBe(true);
  });

  it('replaces an older Stroq entry rather than stacking a second one', () => {
    const old = mergeAntigravityHooks({}, '"/old/node" "/old/index.js" hook antigravity');
    const merged = mergeAntigravityHooks(old, cmd);
    expect(JSON.stringify(merged)).not.toContain('/old/node');
    expect(commandsIn(merged)).toHaveLength(3);
  });

  it('is idempotent', () => {
    const once = mergeAntigravityHooks({}, cmd);
    expect(mergeAntigravityHooks(once, cmd)).toEqual(once);
  });

  it('repairs an entry someone switched off', () => {
    const off: AntigravityHooksJson = {
      [ANTIGRAVITY_HOOK_NAME]: { ...buildAntigravityHook(cmd), enabled: false },
    };
    expect(isStroqAntigravityHooks(off)).toBe(false);
    expect(isStroqAntigravityHooks(mergeAntigravityHooks(off, cmd))).toBe(true);
  });
});

describe('isStroqAntigravityHooks', () => {
  it('is true only when all three events carry a Stroq handler', () => {
    // A half-install is not partial protection: a `pre` without its `post` never
    // taints, a `post` without its `pre` never blocks, and without `PreInvocation` a
    // taint reaches the model through nothing at all.
    const full = mergeAntigravityHooks({}, cmd);
    expect(isStroqAntigravityHooks(full)).toBe(true);
    for (const event of ANTIGRAVITY_HOOK_EVENTS) {
      const half = {
        [ANTIGRAVITY_HOOK_NAME]: { ...ours(full), [event]: [] },
      };
      expect(isStroqAntigravityHooks(half), event).toBe(false);
    }
  });

  it('says false for anything that is not a Stroq entry', () => {
    for (const json of [
      null,
      'nope',
      7,
      [],
      {},
      { stroq: 'nope' },
      { stroq: { PreToolUse: 7 } },
      { 'my-linter-hook': ours(mergeAntigravityHooks({}, cmd)) },
    ])
      expect(isStroqAntigravityHooks(json), JSON.stringify(json) ?? 'undefined').toBe(false);
  });
});

describe('antigravityHooksPath', () => {
  it('is the workspace .agents file for a project and the Gemini config file for a user', () => {
    expect(antigravityHooksPath('project', '/w')).toBe(join('/w', '.agents', 'hooks.json'));
    expect(antigravityHooksPath('user', '/w')).toMatch(/\.gemini[\\/]config[\\/]hooks\.json$/);
  });
});

describe('installAntigravityHooks', () => {
  it('creates the directory, writes the file, and rewrites it identically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-antigravity-init-'));
    const file = antigravityHooksPath('project', dir);
    expect(readAntigravityHooks(file)).toEqual({});
    installAntigravityHooks(file, cmd);
    expect(existsSync(file)).toBe(true);
    const first = readFileSync(file, 'utf8');
    installAntigravityHooks(file, cmd);
    expect(readFileSync(file, 'utf8')).toBe(first);
    expect(isStroqAntigravityHooks(readAntigravityHooks(file))).toBe(true);
  });

  it('keeps a foreign hook that was already in the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-antigravity-init-'));
    const file = antigravityHooksPath('project', dir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      '{ "my-linter-hook": { "PostToolUse": [{ "matcher": "run_command", "hooks": [] }] } }',
    );
    const merged = installAntigravityHooks(file, cmd);
    expect(merged['my-linter-hook']).toBeDefined();
    expect(isStroqAntigravityHooks(merged)).toBe(true);
  });

  it('throws a descriptive error when the file exists but is not JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-antigravity-init-'));
    const file = antigravityHooksPath('project', dir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ not json');
    expect(() => readAntigravityHooks(file)).toThrow(/cannot parse/);
  });
});
