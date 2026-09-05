import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODEX_HIGH_IMPACT_TOOL } from '../../src/adapters/codex.js';
import {
  CODEX_POST_MATCHER,
  CODEX_PRE_MATCHER,
  codexHandler,
  codexHooksPath,
  hasStroqCodexHook,
  installCodexHooks,
  isStroqCodexHook,
  mergeCodexHooks,
  readCodexHooks,
  type CodexHookGroup,
  type CodexHooksJson,
} from '../../src/commands/codex-hooks.js';

const cmd = '"/usr/bin/node" "/x/index.js" hook codex';
/** The `{matcher, commands}` shape of one event's groups in a nested file. */
const nested = (settings: CodexHooksJson, event: string) =>
  (settings.hooks?.[event] ?? []).map((g) => ({
    matcher: g.matcher,
    commands: (g.hooks ?? []).map((h) => h.command),
  }));
/** The same, for a file that keeps its events at the root. */
const rooted = (settings: CodexHooksJson, event: string) =>
  (settings[event] as CodexHookGroup[] | undefined)?.map((g) => ({
    matcher: g.matcher,
    commands: (g.hooks ?? []).map((h) => h.command),
  })) ?? [];

describe('codexHandler', () => {
  it('writes the official handler shape with no failClosed knob', () => {
    expect(codexHandler(cmd)).toEqual({
      type: 'command',
      command: cmd,
      timeout: 15,
      statusMessage: 'Stroq',
    });
    // Every tool name the adapter treats as high-impact, so no Pre event can
    // reach Stroq that its fail-closed path does not also cover.
    expect(CODEX_PRE_MATCHER).toBe(
      'Bash|exec_command|shell|local_shell|apply_patch|ApplyPatch|mcp__.*',
    );
    expect(CODEX_POST_MATCHER).toBe('Bash|exec_command|shell|local_shell|mcp__.*');
    for (const tool of [
      'Bash',
      'exec_command',
      'shell',
      'local_shell',
      'apply_patch',
      'ApplyPatch',
    ])
      expect(CODEX_HIGH_IMPACT_TOOL.test(tool), tool).toBe(true);
  });

  it('recognises only its own entries', () => {
    expect(isStroqCodexHook(codexHandler(cmd))).toBe(true);
    expect(
      isStroqCodexHook({
        type: 'command',
        command: '"/n" "/e.js" hook claude-code',
        timeout: 15,
        statusMessage: 'x',
      }),
    ).toBe(false);
    expect(
      isStroqCodexHook({ type: 'command', command: 'echo hi', timeout: 5, statusMessage: 'x' }),
    ).toBe(false);
  });
});

describe('mergeCodexHooks into a new file', () => {
  it('writes the official nested shape with one group per event', () => {
    const merged = mergeCodexHooks({}, cmd);
    expect(Object.keys(merged.hooks ?? {})).toEqual(['PreToolUse', 'PostToolUse']);
    expect(nested(merged, 'PreToolUse')).toEqual([{ matcher: CODEX_PRE_MATCHER, commands: [cmd] }]);
    expect(nested(merged, 'PostToolUse')).toEqual([
      { matcher: CODEX_POST_MATCHER, commands: [cmd] },
    ]);
    expect(merged.hooks?.['PreToolUse']?.[0]?.hooks?.[0]).toEqual(codexHandler(cmd));
    expect(hasStroqCodexHook(merged)).toBe(true);
    expect(hasStroqCodexHook({})).toBe(false);
  });
});

describe('mergeCodexHooks on an existing nested file', () => {
  const existing: CodexHooksJson = {
    version: 2,
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'echo hi', timeout: 5, statusMessage: 'x' }],
        },
      ],
      SessionStart: [
        {
          matcher: '.*',
          hooks: [{ type: 'command', command: 'echo start', timeout: 5, statusMessage: 'x' }],
        },
      ],
    },
  };

  it('preserves foreign groups, foreign events and other keys, and is idempotent', () => {
    const once = mergeCodexHooks(existing, cmd);
    const twice = mergeCodexHooks(once, cmd);
    expect(twice['version']).toBe(2);
    expect(nested(twice, 'PreToolUse')).toEqual([
      { matcher: 'Bash', commands: ['echo hi'] },
      { matcher: CODEX_PRE_MATCHER, commands: [cmd] },
    ]);
    expect(nested(twice, 'SessionStart')).toEqual([{ matcher: '.*', commands: ['echo start'] }]);
    expect(nested(twice, 'PostToolUse')).toEqual([
      { matcher: CODEX_POST_MATCHER, commands: [cmd] },
    ]);
  });

  it('replaces an older Stroq entry and leaves the other agents alone', () => {
    const old = mergeCodexHooks({}, '"/old/node" "/old/index.js" hook codex');
    const withOthers: CodexHooksJson = {
      ...old,
      hooks: {
        ...old.hooks,
        PreToolUse: [
          ...(old.hooks?.['PreToolUse'] ?? []),
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: '"/n" "/e.js" hook claude-code',
                timeout: 15,
                statusMessage: 'x',
              },
              {
                type: 'command',
                command: '"/n" "/e.js" hook cursor',
                timeout: 15,
                statusMessage: 'x',
              },
            ],
          },
        ],
      },
    };
    expect(nested(mergeCodexHooks(withOthers, cmd), 'PreToolUse')).toEqual([
      { matcher: 'Bash', commands: ['"/n" "/e.js" hook claude-code', '"/n" "/e.js" hook cursor'] },
      { matcher: CODEX_PRE_MATCHER, commands: [cmd] },
    ]);
  });

  it('preserves a malformed group lacking a hooks array, and stays idempotent', () => {
    const malformed = { hooks: { PreToolUse: [{ matcher: 'Bash' }] } } as unknown as CodexHooksJson;
    const once = mergeCodexHooks(malformed, cmd);
    const twice = mergeCodexHooks(once, cmd);
    expect(twice.hooks?.['PreToolUse']?.[0]).toEqual({ matcher: 'Bash' });
    expect(twice.hooks?.['PreToolUse']).toHaveLength(2);
  });

  it('replaces a non-array event value instead of throwing', () => {
    const broken = { hooks: { PostToolUse: 'nope' } } as unknown as CodexHooksJson;
    expect(nested(mergeCodexHooks(broken, cmd), 'PostToolUse')).toEqual([
      { matcher: CODEX_POST_MATCHER, commands: [cmd] },
    ]);
  });
});

const group = (matcher: string, command: string) => ({
  matcher,
  hooks: [{ type: 'command', command, timeout: 5, statusMessage: 'x' }],
});

describe('mergeCodexHooks on a file that keeps its events at the root', () => {
  /** Some community docs show the event map at the root, with no `hooks` wrapper. */
  const flatFile = {
    SessionStart: [group('.*', 'echo start')],
    PreToolUse: [group('Bash', 'echo hi')],
  } as unknown as CodexHooksJson;

  it('migrates the root events into the official hooks wrapper, dropping nothing', () => {
    const merged = mergeCodexHooks(flatFile, cmd);
    // Which shape a file "is" cannot be guessed safely, so the merge always writes
    // the official one and moves what it finds at the root into it.
    expect(merged['PreToolUse']).toBeUndefined();
    expect(merged['SessionStart']).toBeUndefined();
    expect(nested(merged, 'PreToolUse')).toEqual([
      { matcher: 'Bash', commands: ['echo hi'] },
      { matcher: CODEX_PRE_MATCHER, commands: [cmd] },
    ]);
    expect(nested(merged, 'PostToolUse')).toEqual([
      { matcher: CODEX_POST_MATCHER, commands: [cmd] },
    ]);
    expect(nested(merged, 'SessionStart')).toEqual([{ matcher: '.*', commands: ['echo start'] }]);
    expect(hasStroqCodexHook(merged)).toBe(true);
    // Idempotent after the migration: a second install must not stack a second entry.
    expect(JSON.stringify(mergeCodexHooks(merged, cmd))).toBe(JSON.stringify(merged));
  });

  it('keeps both copies when an event is declared in both shapes, hooks first', () => {
    const both = {
      version: 1,
      notes: 'x',
      hooks: { PreToolUse: [group('nested', 'echo nested')] },
      PreToolUse: [group('rooted', 'echo rooted')],
    } as unknown as CodexHooksJson;
    const merged = mergeCodexHooks(both, cmd);
    expect(merged['PreToolUse']).toBeUndefined();
    expect(merged['notes']).toBe('x');
    expect(merged['version']).toBe(1);
    expect(nested(merged, 'PreToolUse')).toEqual([
      { matcher: 'nested', commands: ['echo nested'] },
      { matcher: 'rooted', commands: ['echo rooted'] },
      { matcher: CODEX_PRE_MATCHER, commands: [cmd] },
    ]);
  });

  it('reports a root-level Stroq entry as not installed, then migrates it', () => {
    const rootOnly = { PreToolUse: [group(CODEX_PRE_MATCHER, cmd)] } as unknown as CodexHooksJson;
    // `init` only ever writes under `hooks`, so that is the only place `doctor`
    // may call installed — otherwise a Codex build that reads only `hooks` would
    // leave the user believing they were protected.
    expect(hasStroqCodexHook(rootOnly)).toBe(false);
    const merged = mergeCodexHooks(rootOnly, cmd);
    expect(hasStroqCodexHook(merged)).toBe(true);
    expect(nested(merged, 'PreToolUse')).toEqual([{ matcher: CODEX_PRE_MATCHER, commands: [cmd] }]);
  });
});

describe('mergeCodexHooks on a file whose hooks key is not an event map', () => {
  it.each([
    ['a string', 'garbage'],
    ['an array', [{ matcher: 'Bash', hooks: [] }]],
    ['a number', 7],
  ])('ignores a hooks key that is %s rather than spreading it', (_label, hooks) => {
    const merged = mergeCodexHooks({ hooks } as unknown as CodexHooksJson, cmd);
    // Spreading an array or a string would write numeric keys into the event map.
    expect(Object.keys(merged.hooks ?? {})).toEqual(['PreToolUse', 'PostToolUse']);
    expect(hasStroqCodexHook(merged)).toBe(true);
  });

  it('drops a null group instead of throwing, and keeps the real ones', () => {
    const withNull = {
      hooks: { PreToolUse: [null, group('Bash', 'echo hi'), 'nonsense', { matcher: 'no-hooks' }] },
    } as unknown as CodexHooksJson;
    const merged = mergeCodexHooks(withNull, cmd);
    expect(merged.hooks?.['PreToolUse']).toEqual([
      group('Bash', 'echo hi'),
      { matcher: 'no-hooks' },
      { matcher: CODEX_PRE_MATCHER, hooks: [codexHandler(cmd)] },
    ]);
    expect(hasStroqCodexHook(withNull)).toBe(false);
  });
});

describe('codex hooks files', () => {
  it('computes project and user paths', () => {
    expect(codexHooksPath('project', '/w')).toBe('/w/.codex/hooks.json');
    expect(codexHooksPath('user')).toMatch(/\.codex\/hooks\.json$/);
  });

  it('reads missing or empty files as {} and installs hooks creating directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-codex-init-'));
    const file = codexHooksPath('project', dir);
    expect(readCodexHooks(file)).toEqual({});
    mkdirSync(join(dir, '.codex'));
    writeFileSync(file, '');
    expect(readCodexHooks(file)).toEqual({});
    installCodexHooks(file, cmd);
    expect(existsSync(file)).toBe(true);
    const written = JSON.parse(readFileSync(file, 'utf8')) as CodexHooksJson;
    expect(nested(written, 'PostToolUse')).toEqual([
      { matcher: CODEX_POST_MATCHER, commands: [cmd] },
    ]);
  });

  it('throws a descriptive error when hooks.json has invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-codex-init-'));
    mkdirSync(join(dir, '.codex'));
    const file = codexHooksPath('project', dir);
    writeFileSync(file, '{ not json');
    expect(() => readCodexHooks(file)).toThrow(/cannot parse/);
  });
});
