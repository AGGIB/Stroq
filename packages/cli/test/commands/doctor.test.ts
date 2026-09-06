import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { doctorReport, runDoctor } from '../../src/commands/doctor.js';
import { installCursorHooks, cursorHooksPath } from '../../src/commands/cursor-hooks.js';
import { codexHooksPath, installCodexHooks } from '../../src/commands/codex-hooks.js';
import { copilotHooksPath, installCopilotHooks } from '../../src/commands/copilot-hooks.js';
import { installWindsurfHooks, windsurfHooksPath } from '../../src/commands/windsurf-hooks.js';
import { installHooks, settingsPath } from '../../src/commands/init.js';
import {
  installOpenClawPlugin,
  isStroqOpenClawPlugin,
  openclawPluginDir,
} from '../../src/commands/openclaw-plugin.js';
import { secretsFile } from '../../src/paths.js';

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'stroq-doctor-'));
  process.env['STROQ_HOME'] = join(cwd, 'home');
  process.env['HOME'] = join(cwd, 'fakehome');
});

describe('doctorReport', () => {
  it('reports missing hooks, then installed hooks', async () => {
    const before = await doctorReport(cwd);
    const byName = (name: string) => before.checks.find((c) => c.name === name)!;
    expect(byName('node').ok).toBe(true);
    expect(byName('rules').ok).toBe(true);
    expect(byName('self-test').ok).toBe(true);
    expect(byName('hooks').ok).toBe(false);
    installHooks(settingsPath('project', cwd), '"/n" "/e.js" hook claude-code');
    expect((await doctorReport(cwd)).checks.find((c) => c.name === 'hooks')?.ok).toBe(true);
  });

  it('reports a broken hooks check instead of throwing when settings.json is corrupt', async () => {
    const file = settingsPath('project', cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ not json');
    const report = await doctorReport(cwd);
    const hooksCheck = report.checks.find((c) => c.name === 'hooks')!;
    expect(hooksCheck.ok).toBe(false);
    expect(hooksCheck.detail).toMatch(/cannot parse/);
    expect(hooksCheck.detail).toContain(file);
  });

  it('reports a broken secrets check instead of throwing when secrets.json is unreadable', async () => {
    mkdirSync(secretsFile(), { recursive: true });
    const report = await doctorReport(cwd);
    const secretsCheck = report.checks.find((c) => c.name === 'secrets')!;
    expect(secretsCheck.ok).toBe(false);
    expect(secretsCheck.detail.length).toBeGreaterThan(0);
    expect(report.checks.find((c) => c.name === 'node')?.ok).toBe(true);
    expect(report.checks.find((c) => c.name === 'hooks')).toBeDefined();
  });

  it('says the index is corrupt rather than never built', async () => {
    mkdirSync(dirname(secretsFile()), { recursive: true });
    writeFileSync(secretsFile(), '{ not json');
    const secretsCheck = (await doctorReport(cwd)).checks.find((c) => c.name === 'secrets')!;
    expect(secretsCheck.ok).toBe(false);
    expect(secretsCheck.detail).toBe('index file was corrupt and will be rebuilt');
  });

  it('reports an unreadable source and a truncated index as a failing secrets check', async () => {
    mkdirSync(dirname(secretsFile()), { recursive: true });
    writeFileSync(
      secretsFile(),
      JSON.stringify({
        version: 2,
        salt: 'a'.repeat(32),
        builtAt: new Date().toISOString(),
        sources: [{ path: '/tmp/x/.env', mtimeMs: 1, size: 1 }],
        entries: [],
        canaries: [],
        truncated: true,
        unreadable: 1,
      }),
    );
    const secretsCheck = (await doctorReport(cwd)).checks.find((c) => c.name === 'secrets')!;
    expect(secretsCheck.ok).toBe(false);
    expect(secretsCheck.detail).toBe(
      '0 values from 1 sources, 0 canaries; 1 source unreadable; sources truncated, some values are not indexed',
    );
  });

  it('runDoctor returns 1 without throwing when the project settings.json is corrupt', async () => {
    const file = settingsPath('project', cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ not json');
    const originalCwd = process.cwd();
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      process.chdir(cwd);
      await expect(runDoctor()).resolves.toBe(1);
    } finally {
      process.chdir(originalCwd);
      spy.mockRestore();
    }
  });
});

describe('doctorReport cursor hooks', () => {
  const detailOf = (
    report: { checks: readonly { name: string; detail: string }[] },
    name: string,
  ) => report.checks.find((c) => c.name === name)?.detail ?? '';

  it('reports both agents, and fails both lines when neither is installed', async () => {
    const report = await doctorReport(cwd);
    const cursor = report.checks.find((c) => c.name === 'cursor hooks')!;
    expect(cursor.ok).toBe(false);
    // A failing line keeps the per-scope paths: there is nothing carrying it.
    expect(cursor.detail).toContain(cursorHooksPath('project', cwd));
    expect(cursor.detail).toContain('project: missing');
    expect(report.checks.find((c) => c.name === 'hooks')?.ok).toBe(false);
    expect(detailOf(report, 'hooks')).toContain('project: missing');
  });

  it('passes both lines once Cursor alone is installed', async () => {
    installCursorHooks(cursorHooksPath('project', cwd), '"/n" "/e.js" hook cursor');
    const report = await doctorReport(cwd);
    expect(report.checks.find((c) => c.name === 'cursor hooks')?.ok).toBe(true);
    expect(detailOf(report, 'cursor hooks')).toContain('project: installed');
    // A Cursor-only user must not be told their Claude Code install is broken —
    // and a passing line must not read as a green tick next to the word "missing".
    expect(report.checks.find((c) => c.name === 'hooks')?.ok).toBe(true);
    expect(detailOf(report, 'hooks')).toBe('not installed (ok: cursor hooks are)');
  });

  it('says which agent carries the line when Claude Code alone is installed', async () => {
    installHooks(settingsPath('project', cwd), '"/n" "/e.js" hook claude-code');
    const report = await doctorReport(cwd);
    expect(report.checks.find((c) => c.name === 'cursor hooks')?.ok).toBe(true);
    expect(detailOf(report, 'cursor hooks')).toBe('not installed (ok: hooks are)');
    expect(detailOf(report, 'hooks')).toContain('project: installed');
  });

  it('reports a broken cursor hooks file without failing the Claude Code line', async () => {
    installHooks(settingsPath('project', cwd), '"/n" "/e.js" hook claude-code');
    const file = cursorHooksPath('project', cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ not json');
    const report = await doctorReport(cwd);
    expect(report.checks.find((c) => c.name === 'cursor hooks')?.ok).toBe(false);
    expect(detailOf(report, 'cursor hooks')).toMatch(/cannot parse/);
    expect(report.checks.find((c) => c.name === 'hooks')?.ok).toBe(true);
  });
});

describe('doctorReport codex hooks', () => {
  const detailOf = (
    report: { checks: readonly { name: string; detail: string }[] },
    name: string,
  ) => report.checks.find((c) => c.name === name)?.detail ?? '';

  it('reports six agents and fails all six lines when none is installed', async () => {
    const report = await doctorReport(cwd);
    expect(report.checks.map((c) => c.name)).toEqual([
      'node',
      'rules',
      'self-test',
      'hooks',
      'cursor hooks',
      'codex hooks',
      'copilot hooks',
      'openclaw plugin',
      'windsurf hooks',
      'home',
      'secrets',
    ]);
    const codex = report.checks.find((c) => c.name === 'codex hooks')!;
    expect(codex.ok).toBe(false);
    expect(codex.detail).toContain(codexHooksPath('project', cwd));
    expect(codex.detail).toContain('project: missing');
  });

  it('passes every line once Codex alone is installed', async () => {
    installCodexHooks(codexHooksPath('project', cwd), '"/n" "/e.js" hook codex');
    const report = await doctorReport(cwd);
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(detailOf(report, 'codex hooks')).toContain('project: installed');
    expect(detailOf(report, 'hooks')).toBe('not installed (ok: codex hooks are)');
    expect(detailOf(report, 'cursor hooks')).toBe('not installed (ok: codex hooks are)');
  });

  it('names every agent that is carrying the line', async () => {
    installHooks(settingsPath('project', cwd), '"/n" "/e.js" hook claude-code');
    installCursorHooks(cursorHooksPath('project', cwd), '"/n" "/e.js" hook cursor');
    expect(detailOf(await doctorReport(cwd), 'codex hooks')).toBe(
      'not installed (ok: hooks, cursor hooks are)',
    );
  });

  it('reports a broken codex hooks file without failing the other two lines', async () => {
    installHooks(settingsPath('project', cwd), '"/n" "/e.js" hook claude-code');
    const file = codexHooksPath('project', cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ not json');
    const report = await doctorReport(cwd);
    expect(report.checks.find((c) => c.name === 'codex hooks')?.ok).toBe(false);
    expect(detailOf(report, 'codex hooks')).toMatch(/cannot parse/);
    expect(report.checks.find((c) => c.name === 'hooks')?.ok).toBe(true);
    expect(report.checks.find((c) => c.name === 'cursor hooks')?.ok).toBe(true);
  });

  it('does not call a root-level entry installed; re-running init migrates it', async () => {
    const file = codexHooksPath('project', cwd);
    mkdirSync(dirname(file), { recursive: true });
    const stroqGroup = {
      matcher: 'Bash',
      hooks: [
        {
          type: 'command',
          command: '"/n" "/e.js" hook codex',
          timeout: 15,
          statusMessage: 'Stroq',
        },
      ],
    };
    // `init` only ever writes under `hooks`. A file that still keeps the entry at
    // the root is reported as not installed rather than as protection a Codex
    // build reading only `hooks` would never actually apply.
    writeFileSync(file, JSON.stringify({ PreToolUse: [stroqGroup] }));
    expect((await doctorReport(cwd)).checks.find((c) => c.name === 'codex hooks')?.ok).toBe(false);

    installCodexHooks(file, '"/n" "/e.js" hook codex');
    expect((await doctorReport(cwd)).checks.find((c) => c.name === 'codex hooks')?.ok).toBe(true);
    const migrated = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(migrated['PreToolUse']).toBeUndefined();
  });

  it('reports a hooks file whose event value is not an array as not installed', async () => {
    const file = codexHooksPath('project', cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: 'nope' } }));
    const report = await doctorReport(cwd);
    const codex = report.checks.find((c) => c.name === 'codex hooks');
    expect(codex?.ok).toBe(false);
    expect(codex?.detail).not.toMatch(/cannot parse/);
  });
});

describe('doctorReport copilot hooks', () => {
  const detailOf = (
    report: { checks: readonly { name: string; detail: string }[] },
    name: string,
  ) => report.checks.find((c) => c.name === name)?.detail ?? '';
  const cmd = (phase: string) => `"/n" "/e.js" hook copilot ${phase}`;
  const install = (dir: string) =>
    installCopilotHooks(copilotHooksPath('project', dir), cmd('pre'), cmd('post'));

  it('names the file it looked for when nothing is installed', async () => {
    const copilot = (await doctorReport(cwd)).checks.find((c) => c.name === 'copilot hooks')!;
    expect(copilot.ok).toBe(false);
    expect(copilot.detail).toContain(copilotHooksPath('project', cwd));
    expect(copilot.detail).toContain('project: missing');
  });

  it('passes every line once Copilot alone is installed', async () => {
    install(cwd);
    const report = await doctorReport(cwd);
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(detailOf(report, 'copilot hooks')).toContain('project: installed');
    expect(detailOf(report, 'hooks')).toBe('not installed (ok: copilot hooks are)');
  });

  it('reports a broken copilot hooks file without failing the other lines', async () => {
    installHooks(settingsPath('project', cwd), '"/n" "/e.js" hook claude-code');
    const file = copilotHooksPath('project', cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ not json');
    const report = await doctorReport(cwd);
    expect(report.checks.find((c) => c.name === 'copilot hooks')?.ok).toBe(false);
    expect(detailOf(report, 'copilot hooks')).toMatch(/cannot parse/);
    expect(report.checks.find((c) => c.name === 'hooks')?.ok).toBe(true);
  });

  it('does not call a half-installed file installed', async () => {
    // A `pre` without a `post` never taints and a `post` without a `pre` never
    // blocks; either way the user is not getting what the line would claim.
    const file = copilotHooksPath('project', cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        hooks: { preToolUse: [{ type: 'command', bash: cmd('pre'), timeoutSec: 15 }] },
      }),
    );
    expect((await doctorReport(cwd)).checks.find((c) => c.name === 'copilot hooks')?.ok).toBe(
      false,
    );
    install(cwd);
    expect((await doctorReport(cwd)).checks.find((c) => c.name === 'copilot hooks')?.ok).toBe(true);
  });

  it('does not call a file installed when it is missing `version`', async () => {
    // Copilot drops a hooks file outright when `version` is not 1, so a file
    // that carries both correct entries but no `version` gets no protection —
    // and must not be reported as if it did.
    const file = copilotHooksPath('project', cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          preToolUse: [{ type: 'command', bash: cmd('pre'), timeoutSec: 15 }],
          postToolUse: [{ type: 'command', bash: cmd('post'), timeoutSec: 15 }],
        },
      }),
    );
    const report = await doctorReport(cwd);
    expect(report.checks.find((c) => c.name === 'copilot hooks')?.ok).toBe(false);
  });

  it('finds the user file through COPILOT_HOME', async () => {
    const copilotHome = join(cwd, 'copilot-home');
    process.env['COPILOT_HOME'] = copilotHome;
    try {
      installCopilotHooks(
        copilotHooksPath('user', cwd, { COPILOT_HOME: copilotHome }),
        cmd('pre'),
        cmd('post'),
      );
      const report = await doctorReport(cwd);
      expect(report.checks.find((c) => c.name === 'copilot hooks')?.ok).toBe(true);
      expect(report.checks.find((c) => c.name === 'copilot hooks')?.detail).toContain(
        'user: installed',
      );
    } finally {
      delete process.env['COPILOT_HOME'];
    }
  });
});

describe('doctorReport openclaw plugin', () => {
  const detailOf = (
    report: { checks: readonly { name: string; detail: string }[] },
    name: string,
  ) => report.checks.find((c) => c.name === name)?.detail ?? '';
  const install = () =>
    installOpenClawPlugin(openclawPluginDir(), [process.execPath, '/x/index.js']);

  it('names the entry it looked for when nothing is installed', async () => {
    const openclaw = (await doctorReport(cwd)).checks.find((c) => c.name === 'openclaw plugin')!;
    expect(openclaw.ok).toBe(false);
    expect(openclaw.detail).toContain(openclawPluginDir());
    expect(openclaw.detail).toContain('missing');
  });

  it('passes every line once OpenClaw alone is installed', async () => {
    install();
    expect(isStroqOpenClawPlugin(openclawPluginDir())).toBe(true);
    const report = await doctorReport(cwd);
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(detailOf(report, 'openclaw plugin')).toContain('installed');
    expect(detailOf(report, 'hooks')).toBe('not installed (ok: openclaw plugin are)');
  });

  it('does not call a half-install installed, and names the manifest that is actually wrong', async () => {
    // An entry with no manifest is a directory the Gateway will not load, and a
    // green line beside it would promise protection that is not running.
    const dir = openclawPluginDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.js'), 'export const register = () => {};');
    const report = await doctorReport(cwd);
    expect(report.checks.find((c) => c.name === 'openclaw plugin')?.ok).toBe(false);
    // Task 3 review, minor: `index.js` DOES exist in this half-install, so pointing
    // the "missing" message at it would name the wrong file — the manifest is what
    // is actually missing, and is what `isStroqOpenClawPlugin` decides on.
    expect(detailOf(report, 'openclaw plugin')).toContain('openclaw.plugin.json');
    expect(detailOf(report, 'openclaw plugin')).not.toContain('index.js');
    install();
    expect((await doctorReport(cwd)).checks.find((c) => c.name === 'openclaw plugin')?.ok).toBe(
      true,
    );
  });

  it('names the shipped file a pruned directory is missing', async () => {
    // `index.js` cannot load without `run-stroq.js`, so a directory missing it is a
    // plugin the Gateway fails to register — reporting it as installed would put a
    // green tick next to a firewall that is not running.
    install();
    rmSync(join(openclawPluginDir(), 'run-stroq.js'));
    const report = await doctorReport(cwd);
    expect(report.checks.find((c) => c.name === 'openclaw plugin')?.ok).toBe(false);
    expect(detailOf(report, 'openclaw plugin')).toContain('run-stroq.js');
  });

  it('reports one scope, because OpenClaw plugins are per Gateway host', async () => {
    // No project/user split: there is one directory, and printing two would invite a
    // user to look for a per-repository install that does not exist.
    const detail = detailOf(await doctorReport(cwd), 'openclaw plugin');
    expect(detail.split(';')).toHaveLength(1);
  });
});

describe('doctorReport windsurf hooks', () => {
  const detailOf = (
    report: { checks: readonly { name: string; detail: string }[] },
    name: string,
  ) => report.checks.find((c) => c.name === name)?.detail ?? '';
  const cmd = '"/n" "/e.js" hook windsurf';

  it('names the file it looked for when nothing is installed', async () => {
    const windsurf = (await doctorReport(cwd)).checks.find((c) => c.name === 'windsurf hooks')!;
    expect(windsurf.ok).toBe(false);
    expect(windsurf.detail).toContain(windsurfHooksPath('project', cwd));
    expect(windsurf.detail).toContain('project: missing');
  });

  it('passes every line once Windsurf alone is installed', async () => {
    installWindsurfHooks(windsurfHooksPath('project', cwd), cmd);
    const report = await doctorReport(cwd);
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(detailOf(report, 'windsurf hooks')).toContain('project: installed');
    expect(detailOf(report, 'hooks')).toBe('not installed (ok: windsurf hooks are)');
  });

  it('reports a half-install as not installed', async () => {
    // A `pre` without its `post` never taints and a `post` without its `pre` never
    // blocks, so five events out of six is not partial protection.
    const file = windsurfHooksPath('project', cwd);
    installWindsurfHooks(file, cmd);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    delete parsed.hooks['post_mcp_tool_use'];
    writeFileSync(file, JSON.stringify(parsed));
    expect((await doctorReport(cwd)).checks.find((c) => c.name === 'windsurf hooks')?.ok).toBe(
      false,
    );
  });

  it('reports a broken windsurf hooks file without failing the other lines', async () => {
    installHooks(settingsPath('project', cwd), '"/n" "/e.js" hook claude-code');
    const file = windsurfHooksPath('project', cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ not json');
    const report = await doctorReport(cwd);
    expect(report.checks.find((c) => c.name === 'windsurf hooks')?.ok).toBe(false);
    expect(detailOf(report, 'windsurf hooks')).toMatch(/cannot parse/);
    expect(report.checks.find((c) => c.name === 'hooks')?.ok).toBe(true);
  });

  it('ignores a foreign hooks file that Stroq did not write', async () => {
    const file = windsurfHooksPath('project', cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ "hooks": { "pre_run_command": [{ "command": "echo hi" }] } }');
    expect((await doctorReport(cwd)).checks.find((c) => c.name === 'windsurf hooks')?.ok).toBe(
      false,
    );
  });
});
