import { existsSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { hookArgv, hookCommand, runInit, settingsPath } from '../../src/commands/init.js';
import { cursorHooksPath } from '../../src/commands/cursor-hooks.js';
import { codexHooksPath } from '../../src/commands/codex-hooks.js';
import { copilotHooksPath } from '../../src/commands/copilot-hooks.js';
import {
  OPENCLAW_COMMAND_FILE,
  isStroqOpenClawPlugin,
  openclawPluginDir,
} from '../../src/commands/openclaw-plugin.js';

/**
 * Split out of `init.test.ts` (the 400-line-per-test-file budget), the way
 * `copilot.test.ts` / `copilot-shapes.test.ts` / `copilot-decisions.test.ts` are
 * split — each test file below re-declares its own small helpers rather than
 * importing them from a sibling, which is the existing convention.
 */

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

describe('hookArgv', () => {
  it('is the same command as hookCommand, as argv rather than one quoted line', () => {
    // The OpenClaw plugin spawns Stroq instead of shelling out, so it needs the parts.
    expect(hookArgv('/usr/bin/node', '/opt/stroq/dist/index.js')).toEqual([
      '/usr/bin/node',
      '/opt/stroq/dist/index.js',
    ]);
    expect(hookArgv('/usr/bin/node', '/w/src/index.ts')).toEqual([
      '/usr/bin/node',
      '--import',
      'tsx',
      '/w/src/index.ts',
    ]);
    // The loader rule is shared, so the two can never disagree about it.
    expect(hookCommand('/usr/bin/node', '/w/src/index.ts', 'openclaw')).toContain('--import tsx');
  });
});

describe('runInit --agent openclaw', () => {
  const tmpBin = () => mkdtempSync(join(tmpdir(), 'stroq-openclaw-bin-'));

  /** Restores by DELETING when the variable was unset: assigning `undefined` stores "undefined". */
  async function withEnv<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
    const original = process.env[key];
    process.env[key] = value;
    try {
      return await fn();
    } finally {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }

  const withPath = <T>(path: string, fn: () => Promise<T>): Promise<T> => withEnv('PATH', path, fn);
  const inHome = <T>(home: string, fn: () => Promise<T>): Promise<T> =>
    withEnv('STROQ_HOME', home, fn);
  /** A PATH with no `openclaw` on it, so `init` only prints the two commands. */
  const withoutOpenClaw = <T>(fn: () => Promise<T>): Promise<T> => withPath(tmpBin(), fn);

  it('materialises the plugin under STROQ_HOME and is idempotent', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stroq-init-openclaw-'));
    const out = capture();
    const code = await inHome(home, () => withoutOpenClaw(() => runInit(['--agent', 'openclaw'])));
    out.restore();
    expect(code).toBe(0);
    const dir = openclawPluginDir({ STROQ_HOME: home });
    expect(isStroqOpenClawPlugin(dir)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, OPENCLAW_COMMAND_FILE), 'utf8')).command[0]).toBe(
      process.execPath,
    );

    const printed = out.lines.join('');
    expect(printed).toContain(dir);
    // The four things an OpenClaw user has to know that no other agent needs.
    expect(printed).toContain('restart');
    expect(printed).toContain('/approve');
    expect(printed).toContain('workspace');
    expect(printed).toContain('per Gateway');
    // OpenClaw was not on PATH, so the two commands are printed for the user to run.
    expect(printed).toContain('openclaw plugins install --link');
    expect(printed).toContain('openclaw plugins enable stroq');

    const before = readFileSync(join(dir, 'index.js'), 'utf8');
    const again = capture();
    await inHome(home, () => withoutOpenClaw(() => runInit(['--agent', 'openclaw'])));
    again.restore();
    expect(readFileSync(join(dir, 'index.js'), 'utf8')).toBe(before);
  });

  it('prints the plan and writes nothing with --dry-run', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stroq-init-openclaw-'));
    const out = capture();
    const code = await inHome(home, () =>
      withoutOpenClaw(() => runInit(['--agent', 'openclaw', '--dry-run'])),
    );
    out.restore();
    expect(code).toBe(0);
    // stdout stays parseable, so `init --agent openclaw --dry-run | jq` works.
    const plan = JSON.parse(out.lines.join('')) as { directory: string; install: string[] };
    expect(plan.directory).toBe(openclawPluginDir({ STROQ_HOME: home }));
    expect(plan.install).toHaveLength(2);
    expect(existsSync(join(plan.directory, 'index.js'))).toBe(false);
  });

  it('runs the two commands when openclaw is on PATH', async () => {
    // A stand-in for the Gateway CLI. `initOpenClaw` has no seam to inject a fake
    // `RunCommand`, so whatever `openclaw` resolves to on PATH really is spawned via
    // `spawnSync` — and this sandbox hangs when it executes a shebang script that
    // way, so the stand-in has to be a real, shebang-free executable rather than a
    // hand-written `#!/bin/sh` stub. `/bin/echo` is exactly that: it is symlinked to
    // a file named `openclaw`, and its own stdout (the argv it was given back) is
    // what `initOpenClaw` relays to the user, so both commands are still verified
    // end to end.
    const bin = mkdtempSync(join(tmpdir(), 'stroq-openclaw-bin-'));
    symlinkSync('/bin/echo', join(bin, 'openclaw'));

    const home = mkdtempSync(join(tmpdir(), 'stroq-init-openclaw-'));
    const out = capture();
    await inHome(home, () => withPath(bin, () => runInit(['--agent', 'openclaw'])));
    out.restore();
    const printed = out.lines.join('');
    // Task 3 review, Important: both substrings below also appear in the "not on
    // PATH" branch's printed instructions, so on their own they cannot tell a
    // regression that stops running the commands from the case that actually ran
    // them. The "$ openclaw ..." echo line only appears when a command is actually
    // run (see `initOpenClaw`), so it — plus the absence of the other branch's own
    // wording — is what proves this one really executed.
    expect(printed).not.toContain('not on PATH');
    expect(printed).toContain('$ openclaw plugins install --link');
    expect(printed).toContain('$ openclaw plugins enable stroq');
    expect(printed).toContain('plugins install --link');
    expect(printed).toContain('plugins enable stroq');
  });

  it('warns when the entry it recorded lives in the npx cache', async () => {
    // `npx @stroq/cli init --agent openclaw` records a path under `_npx/`, which
    // vanishes the next time npm prunes that cache. The plugin survives it (it falls
    // back to `stroq` on PATH), but only a global install keeps the recorded command
    // itself valid, so `init` says so at the one moment the user can act on it.
    const home = mkdtempSync(join(tmpdir(), 'stroq-init-openclaw-'));
    const originalEntry = process.argv[1];
    process.argv[1] = join(tmpdir(), '.npm', '_npx', 'a1b2c3', 'node_modules', '.bin', 'stroq');
    const out = capture();
    try {
      await inHome(home, () => withoutOpenClaw(() => runInit(['--agent', 'openclaw'])));
    } finally {
      out.restore();
      if (originalEntry === undefined) process.argv.length = 1;
      else process.argv[1] = originalEntry;
    }
    const printed = out.lines.join('');
    expect(printed).toContain('npx cache');
    expect(printed).toContain('install @stroq/cli globally');
  });

  it('says nothing about npx for an ordinary install', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stroq-init-openclaw-'));
    const out = capture();
    await inHome(home, () => withoutOpenClaw(() => runInit(['--agent', 'openclaw'])));
    out.restore();
    expect(out.lines.join('')).not.toContain('npx cache');
  });

  it('does not touch the other agents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-init-openclaw-'));
    const home = mkdtempSync(join(tmpdir(), 'stroq-init-openclaw-home-'));
    const out = capture();
    await inHome(home, () =>
      withoutOpenClaw(() => inDir(dir, () => runInit(['--agent', 'openclaw']))),
    );
    out.restore();
    expect(existsSync(settingsPath('project', dir))).toBe(false);
    expect(existsSync(cursorHooksPath('project', dir))).toBe(false);
    expect(existsSync(codexHooksPath('project', dir))).toBe(false);
    expect(existsSync(copilotHooksPath('project', dir))).toBe(false);
  });
});
