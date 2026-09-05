import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
    expect(CODEX_PRE_MATCHER).toBe('Bash|apply_patch|mcp__.*');
    expect(CODEX_POST_MATCHER).toBe('Bash|mcp__.*');
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

describe('mergeCodexHooks on a flat file', () => {
  /** Some community docs show the event map at the root, with no `hooks` wrapper. */
  const flatFile = {
    SessionStart: [
      {
        matcher: '.*',
        hooks: [{ type: 'command', command: 'echo start', timeout: 5, statusMessage: 'x' }],
      },
    ],
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'echo hi', timeout: 5, statusMessage: 'x' }],
      },
    ],
  } as unknown as CodexHooksJson;

  it('keeps the events at the root rather than rewriting the file', () => {
    const merged = mergeCodexHooks(flatFile, cmd);
    expect(merged.hooks).toBeUndefined();
    expect(rooted(merged, 'PreToolUse')).toEqual([
      { matcher: 'Bash', commands: ['echo hi'] },
      { matcher: CODEX_PRE_MATCHER, commands: [cmd] },
    ]);
    expect(rooted(merged, 'PostToolUse')).toEqual([
      { matcher: CODEX_POST_MATCHER, commands: [cmd] },
    ]);
    expect(merged['SessionStart']).toEqual(flatFile['SessionStart']);
    expect(hasStroqCodexHook(merged)).toBe(true);
    // Idempotent in this shape too: a second install must not stack a second entry.
    expect(JSON.stringify(mergeCodexHooks(merged, cmd))).toBe(JSON.stringify(merged));
  });

  it('treats a file with a hooks wrapper as nested even when it also has root keys', () => {
    const merged = mergeCodexHooks(
      { version: 1, hooks: {}, notes: 'x' } as unknown as CodexHooksJson,
      cmd,
    );
    expect(Object.keys(merged.hooks ?? {})).toEqual(['PreToolUse', 'PostToolUse']);
    expect(merged['notes']).toBe('x');
    expect(merged['PreToolUse']).toBeUndefined();
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
