import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
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
import { CODEX_PRE_MATCHER, codexHooksPath } from '../../src/commands/codex-hooks.js';
import { copilotHooksPath, isStroqCopilotHooks } from '../../src/commands/copilot-hooks.js';

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

/** Both streams at once: `init` prints its warnings on stderr, everything else on stdout. */
function captureBoth(): {
  readonly out: string[];
  readonly err: string[];
  readonly restore: () => void;
} {
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return {
    out,
    err,
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
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
    const code = await runInit(['--agent', 'openclaw']);
    out.restore();
    expect(code).toBe(1);
    expect(out.lines.join('')).toBe(
      'unknown agent "openclaw" (supported: claude-code, cursor, codex, copilot)\n',
    );
  });
});

describe('hookCommand for codex', () => {
  it('ends with the agent name, which is how init finds its own entries', () => {
    expect(hookCommand('/usr/bin/node', '/opt/stroq/dist/index.js', 'codex')).toBe(
      '"/usr/bin/node" "/opt/stroq/dist/index.js" hook codex',
    );
    expect(hookCommand('/usr/bin/node', '/w/src/index.ts', 'codex')).toBe(
      '"/usr/bin/node" --import tsx "/w/src/index.ts" hook codex',
    );
  });
});

describe('runInit --agent codex', () => {
  it('writes .codex/hooks.json for the project and is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-init-codex-'));
    const out = capture();
    const code = await inDir(dir, () => runInit(['--agent', 'codex']));
    out.restore();
    expect(code).toBe(0);
    const file = codexHooksPath('project', dir);
    const printed = out.lines.join('');
    expect(printed).toContain(file);
    expect(printed).toContain(CODEX_PRE_MATCHER);
    expect(printed).toContain('apply_patch');
    // The two things a Codex user has to know that no other agent needs.
    expect(printed).toContain('[features] hooks = true');
    expect(printed).toContain('trust');
    const first = readFileSync(file, 'utf8');
    const parsed = JSON.parse(first);
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0].hooks[0].statusMessage).toBe('Stroq');
    expect(parsed.hooks.PreToolUse[0].hooks[0].failClosed).toBeUndefined();

    const again = capture();
    await inDir(dir, () => runInit(['--agent', 'codex']));
    again.restore();
    expect(readFileSync(file, 'utf8')).toBe(first);
  });

  it('prints the merged file and writes nothing with --dry-run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-init-codex-'));
    const out = capture();
    const code = await inDir(dir, () => runInit(['--agent', 'codex', '--dry-run']));
    out.restore();
    expect(code).toBe(0);
    expect(JSON.parse(out.lines.join('')).hooks.PostToolUse).toHaveLength(1);
    expect(existsSync(codexHooksPath('project', dir))).toBe(false);
  });

  it('does not touch the other agents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-init-codex-'));
    const out = capture();
    await inDir(dir, () => runInit(['--agent', 'codex']));
    out.restore();
    expect(existsSync(settingsPath('project', dir))).toBe(false);
    expect(existsSync(cursorHooksPath('project', dir))).toBe(false);
  });
});

describe('hookCommand for copilot', () => {
  it('ends with the agent name; init appends the phase to it', () => {
    expect(hookCommand('/usr/bin/node', '/opt/stroq/dist/index.js', 'copilot')).toBe(
      '"/usr/bin/node" "/opt/stroq/dist/index.js" hook copilot',
    );
    expect(hookCommand('/usr/bin/node', '/w/src/index.ts', 'copilot')).toBe(
      '"/usr/bin/node" --import tsx "/w/src/index.ts" hook copilot',
    );
  });
});

describe('runInit --agent copilot', () => {
  it('writes .github/hooks/stroq.json for the project and is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-init-copilot-'));
    const out = capture();
    const code = await inDir(dir, () => runInit(['--agent', 'copilot']));
    out.restore();
    expect(code).toBe(0);
    const file = copilotHooksPath('project', dir);
    const printed = out.lines.join('');
    expect(printed).toContain(file);
    // The three things a Copilot user has to know that no other agent needs.
    expect(printed).toContain('restart');
    expect(printed).toContain('stroq.json');
    expect(printed).toContain('cloud coding agent');
    const first = readFileSync(file, 'utf8');
    const parsed = JSON.parse(first) as {
      version: number;
      hooks: Record<string, { bash: string; timeoutSec: number }[]>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.hooks['preToolUse']?.[0]?.bash).toMatch(/ hook copilot pre$/);
    expect(parsed.hooks['postToolUse']?.[0]?.bash).toMatch(/ hook copilot post$/);
    // Copilot's own default, not the 15 s the other three agents get: a timed-out
    // Copilot hook is an allow, so a shorter budget would be strictly less safe.
    expect(parsed.hooks['preToolUse']?.[0]?.timeoutSec).toBe(30);
    expect(isStroqCopilotHooks(parsed)).toBe(true);

    const again = capture();
    await inDir(dir, () => runInit(['--agent', 'copilot']));
    again.restore();
    expect(readFileSync(file, 'utf8')).toBe(first);
  });

  it('prints the file and writes nothing with --dry-run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-init-copilot-'));
    const out = capture();
    const code = await inDir(dir, () => runInit(['--agent', 'copilot', '--dry-run']));
    out.restore();
    expect(code).toBe(0);
    expect(JSON.parse(out.lines.join('')).hooks.postToolUse).toHaveLength(1);
    expect(existsSync(copilotHooksPath('project', dir))).toBe(false);
  });

  it('does not touch the other agents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-init-copilot-'));
    const out = capture();
    await inDir(dir, () => runInit(['--agent', 'copilot']));
    out.restore();
    expect(existsSync(settingsPath('project', dir))).toBe(false);
    expect(existsSync(cursorHooksPath('project', dir))).toBe(false);
    expect(existsSync(codexHooksPath('project', dir))).toBe(false);
  });

  it('says so before replacing a stroq.json Stroq did not write', async () => {
    // The overwrite stays unconditional — the name is Stroq's by contract — but a
    // file whose contents nobody recognises is never replaced silently.
    const dir = mkdtempSync(join(tmpdir(), 'stroq-init-copilot-'));
    const file = copilotHooksPath('project', dir);
    mkdirSync(join(dir, '.github', 'hooks'), { recursive: true });
    writeFileSync(file, '{ "version": 1, "hooks": { "sessionStart": [] } }');
    // `init` reports the path it actually wrote, i.e. the resolved cwd: on macOS
    // the temp directory is reached through a symlink.
    const shown = copilotHooksPath('project', realpathSync(dir));

    const both = captureBoth();
    await inDir(dir, () => runInit(['--agent', 'copilot']));
    both.restore();
    // On stderr, so a `--dry-run | jq` pipeline still sees only the file.
    expect(both.err.join('')).toBe(`replacing ${shown}, which Stroq did not write\n`);
    expect(both.out.join('')).not.toContain('which Stroq did not write');
    expect(isStroqCopilotHooks(JSON.parse(readFileSync(file, 'utf8')))).toBe(true);

    // A re-run now finds its own file and says nothing.
    const again = captureBoth();
    await inDir(dir, () => runInit(['--agent', 'copilot']));
    again.restore();
    expect(again.err.join('')).toBe('');
  });

  it('warns in the conditional tense with --dry-run, and still writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-init-copilot-'));
    const file = copilotHooksPath('project', dir);
    mkdirSync(join(dir, '.github', 'hooks'), { recursive: true });
    writeFileSync(file, '{ "hooks": {} }');
    const shown = copilotHooksPath('project', realpathSync(dir));

    const both = captureBoth();
    await inDir(dir, () => runInit(['--agent', 'copilot', '--dry-run']));
    both.restore();
    expect(both.err.join('')).toBe(`would replace ${shown}, which Stroq did not write\n`);
    // stdout stays parseable: the preview is the only thing on it.
    expect(JSON.parse(both.out.join('')).version).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe('{ "hooks": {} }');
  });
});
