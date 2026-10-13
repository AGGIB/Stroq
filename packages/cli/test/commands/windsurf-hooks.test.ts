import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  definesWindsurfHooks,
  devinHooksPath,
  installWindsurfHooks,
  isStroqWindsurfHook,
  isStroqWindsurfHooks,
  mergeWindsurfHooks,
  readDevinWorkspaceHooks,
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
    expect(windsurfHooksPath('project', '/w')).toBe(join('/w', '.windsurf', 'hooks.json'));
    // `~/.codeium/windsurf/hooks.json` is the Windsurf IDE's user file. The JetBrains
    // plugin reads `~/.codeium/hooks.json`, which `init` deliberately does not write.
    expect(windsurfHooksPath('user', '/w')).toMatch(/\.codeium[\\/]windsurf[\\/]hooks\.json$/);
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

// Devin Desktop is the renamed Windsurf. Its documentation (docs.devin.ai/desktop/cascade/hooks)
// reads `.devin/hooks.json` first and falls back to `.windsurf/hooks.json` "only when
// `.devin/hooks.json` is absent or defines no hooks": a project install in the second
// file is switched off by a repository's own first one.
describe('devinHooksPath', () => {
  it('is the workspace file Devin Desktop reads before .windsurf/hooks.json', () => {
    expect(devinHooksPath('/w')).toBe(join('/w', '.devin', 'hooks.json'));
  });
});

describe('definesWindsurfHooks', () => {
  it('is true when any event carries at least one entry', () => {
    expect(definesWindsurfHooks({ hooks: { pre_run_command: [{ command: 'echo hi' }] } })).toBe(
      true,
    );
    expect(
      definesWindsurfHooks({
        hooks: { pre_run_command: [], post_run_command: [{ command: 'echo hi' }] },
      }),
    ).toBe(true);
  });

  it('is false for everything that defines no hook, which Devin Desktop reads straight past', () => {
    const empty: readonly unknown[] = [
      {},
      { hooks: {} },
      { hooks: { pre_run_command: [] } },
      { hooks: { pre_run_command: 'echo hi' } },
      { hooks: [] },
      { hooks: 'x' },
      { hooks: null },
      [],
      null,
      'text',
      7,
    ];
    for (const json of empty) expect(definesWindsurfHooks(json), JSON.stringify(json)).toBe(false);
  });
});

describe('readDevinWorkspaceHooks', () => {
  const project = (): string => mkdtempSync(join(tmpdir(), 'stroq-devin-'));
  const put = (dir: string, text: string): void => {
    mkdirSync(join(dir, '.devin'), { recursive: true });
    writeFileSync(devinHooksPath(dir), text);
  };

  it('says absent when the project has no .devin/hooks.json', () => {
    expect(readDevinWorkspaceHooks(project())).toEqual({ state: 'absent' });
  });

  it('says empty for a file that defines no hook', () => {
    for (const text of ['', '{}', '{ "hooks": {} }', '{ "hooks": { "pre_run_command": [] } }']) {
      const dir = project();
      put(dir, text);
      expect(readDevinWorkspaceHooks(dir), text).toEqual({ state: 'empty' });
    }
  });

  it('says defined, and whether Stroq is among the hooks', () => {
    const foreign = project();
    put(foreign, '{ "hooks": { "pre_run_command": [{ "command": "echo hi" }] } }');
    expect(readDevinWorkspaceHooks(foreign)).toMatchObject({
      state: 'defined',
      carriesStroq: false,
    });

    const ours = project();
    installWindsurfHooks(devinHooksPath(ours), cmd);
    expect(readDevinWorkspaceHooks(ours)).toMatchObject({ state: 'defined', carriesStroq: true });
  });

  it('does not count a half-install as Stroq being there', () => {
    const dir = project();
    put(dir, JSON.stringify({ hooks: { pre_run_command: [windsurfEntry(cmd)] } }));
    expect(readDevinWorkspaceHooks(dir)).toMatchObject({ state: 'defined', carriesStroq: false });
  });

  it('carries the file text, so a caller can check what the entries run', () => {
    const dir = project();
    installWindsurfHooks(devinHooksPath(dir), cmd);
    const read = readDevinWorkspaceHooks(dir);
    expect(read.state === 'defined' && read.text.includes(cmd.replaceAll('"', '\\"'))).toBe(true);
  });

  it('says unreadable, with the reason and without the file text, for a file that is not JSON', () => {
    const dir = project();
    put(dir, '{ "hooks": the-secret-token-value');
    const read = readDevinWorkspaceHooks(dir);
    expect(read.state).toBe('unreadable');
    const message = read.state === 'unreadable' ? read.message : '';
    expect(message).toContain('cannot parse');
    expect(message).not.toContain('the-secret-token-value');
  });
});

// Only "there is no such file" means there is nothing to find. Anything else that stops the
// read leaves it unknown whether Devin Desktop reads the file, and says so.
describe('readDevinWorkspaceHooks on a file that is not an ordinary one', () => {
  const project = (): string => mkdtempSync(join(tmpdir(), 'stroq-devin-odd-'));
  const put = (dir: string, text: string): void => {
    mkdirSync(join(dir, '.devin'), { recursive: true });
    writeFileSync(devinHooksPath(dir), text);
  };

  it.each([
    ['a JSON array', '[]'],
    ['a JSON string', '"hooks"'],
    ['hooks as a list', '{ "hooks": [] }'],
    ['hooks as a string', '{ "hooks": "x" }'],
    ['an event that is not a list', '{ "hooks": { "pre_run_command": {} } }'],
    ['an event that is a string', '{ "hooks": { "pre_run_command": "echo hi" } }'],
  ])(
    'says unreadable for %s, since what Devin Desktop does with it is not documented',
    (_n, text) => {
      const dir = project();
      put(dir, text);
      const read = readDevinWorkspaceHooks(dir);
      expect(read.state).toBe('unreadable');
      expect(read.state === 'unreadable' && read.message.includes(devinHooksPath(dir))).toBe(true);
    },
  );

  it.each([
    ['hooks null', '{ "hooks": null }'],
    ['hooks an empty object', '{ "hooks": {} }'],
    ['no hooks key', '{ "version": 1 }'],
    ['an empty file', ''],
    ['white space', '  \n'],
  ])('still says empty for %s', (_n, text) => {
    const dir = project();
    put(dir, text);
    expect(readDevinWorkspaceHooks(dir)).toEqual({ state: 'empty' });
  });

  it('does not put an event name from the file into its message', () => {
    const dir = project();
    put(dir, '{ "hooks": { "\u001b[31mowned": "x" } }');
    const read = readDevinWorkspaceHooks(dir);
    expect(read.state === 'unreadable' && read.message.includes('owned')).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'says unreadable for a directory named hooks.json',
    () => {
      const dir = project();
      mkdirSync(devinHooksPath(dir), { recursive: true });
      expect(readDevinWorkspaceHooks(dir).state).toBe('unreadable');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'says absent for a link to nothing, which Devin Desktop cannot read either',
    () => {
      const dir = project();
      mkdirSync(join(dir, '.devin'), { recursive: true });
      symlinkSync(join(dir, 'nowhere.json'), devinHooksPath(dir));
      expect(readDevinWorkspaceHooks(dir)).toEqual({ state: 'absent' });
    },
  );

  it.skipIf(process.platform === 'win32')('says unreadable for a link that loops', () => {
    const dir = project();
    mkdirSync(join(dir, '.devin'), { recursive: true });
    symlinkSync(devinHooksPath(dir), devinHooksPath(dir));
    expect(readDevinWorkspaceHooks(dir).state).toBe('unreadable');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'says unreadable when the directory cannot be entered, rather than that there is no file',
    () => {
      const dir = project();
      put(dir, '{ "hooks": { "pre_run_command": [{ "command": "echo hi" }] } }');
      chmodSync(join(dir, '.devin'), 0o000);
      try {
        expect(readDevinWorkspaceHooks(dir).state).toBe('unreadable');
      } finally {
        chmodSync(join(dir, '.devin'), 0o755);
      }
    },
  );
});
