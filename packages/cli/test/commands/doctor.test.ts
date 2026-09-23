import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { doctorReport, runDoctor } from '../../src/commands/doctor.js';
import { installCursorHooks, cursorHooksPath } from '../../src/commands/cursor-hooks.js';
import { codexHooksPath, installCodexHooks } from '../../src/commands/codex-hooks.js';
import { copilotHooksPath, installCopilotHooks } from '../../src/commands/copilot-hooks.js';
import { installWindsurfHooks, windsurfHooksPath } from '../../src/commands/windsurf-hooks.js';
import {
  antigravityHooksPath,
  installAntigravityHooks,
} from '../../src/commands/antigravity-hooks.js';
import { installHooks, settingsPath } from '../../src/commands/init.js';
import {
  installOpenClawPlugin,
  isStroqOpenClawPlugin,
  openclawPluginDir,
} from '../../src/commands/openclaw-plugin.js';
import { secretsFile } from '../../src/paths.js';
import { mcpConfigPath, wrapMcpConfig } from '../../src/commands/mcp-config.js';
import { writeJsonObject } from '../../src/commands/config-file.js';

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'stroq-doctor-'));
  process.env['STROQ_HOME'] = join(cwd, 'home');
  process.env['HOME'] = join(cwd, 'fakehome');
});

describe('doctorReport', () => {
  it('does not count post-only Claude hooks as installed protection', async () => {
    const file = settingsPath('project', cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: 'Read|WebFetch|WebSearch|Bash|Grep|mcp__.*',
              hooks: [{ type: 'command', command: '"/n" "/e.js" hook claude-code', timeout: 15 }],
            },
          ],
        },
      }),
    );
    const check = (await doctorReport(cwd, { all: true })).checks.find((c) => c.name === 'hooks');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('PreToolUse');
  });

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
  it('does not count a post-only or fail-open Cursor configuration as installed', async () => {
    const file = cursorHooksPath('project', cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          afterShellExecution: [{ command: '"/n" "/e.js" hook cursor' }],
        },
      }),
    );
    const postOnly = (await doctorReport(cwd, { all: true })).checks.find(
      (c) => c.name === 'cursor hooks',
    );
    expect(postOnly?.ok).toBe(false);
    expect(postOnly?.detail).toContain('beforeShellExecution');
    installCursorHooks(file, '"/n" "/e.js" hook cursor');
    const installed = JSON.parse(readFileSync(file, 'utf8')) as {
      hooks: Record<string, { command: string; failClosed?: boolean }[]>;
    };
    installed.hooks['beforeShellExecution']![0]!.failClosed = false;
    writeFileSync(file, JSON.stringify(installed));
    const failOpen = (await doctorReport(cwd, { all: true })).checks.find(
      (c) => c.name === 'cursor hooks',
    );
    expect(failOpen?.ok).toBe(false);
    expect(failOpen?.detail).toContain('beforeShellExecution (failClosed)');
  });

  it('requires the Cursor write/delete preToolUse gate and its exact matcher', async () => {
    const file = cursorHooksPath('project', cwd);
    installCursorHooks(file, '"/n" "/e.js" hook cursor');
    const installed = JSON.parse(readFileSync(file, 'utf8')) as {
      hooks: Record<string, { command: string; matcher?: string; failClosed?: boolean }[]>;
    };
    installed.hooks['preToolUse']![0]!.matcher = 'Shell';
    writeFileSync(file, JSON.stringify(installed));
    const report = (await doctorReport(cwd, { all: true })).checks.find(
      (check) => check.name === 'cursor hooks',
    );
    expect(report?.ok).toBe(false);
    expect(report?.detail).toContain('preToolUse');
  });

  const detailOf = (
    report: { checks: readonly { name: string; detail: string }[] },
    name: string,
  ) => report.checks.find((c) => c.name === name)?.detail ?? '';

  it('reports both agents, and fails both lines when neither is installed', async () => {
    const report = await doctorReport(cwd, { all: true });
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

  it('collapses to one failing hooks line when none is installed, and --all restores all seven agents plus the MCP proxy', async () => {
    const collapsed = await doctorReport(cwd);
    expect(collapsed.checks.map((c) => c.name)).toEqual([
      'stroq',
      'node',
      'rules',
      'self-test',
      'hooks',
      'home',
      'secrets',
    ]);
    expect(collapsed.checks.find((c) => c.name === 'hooks')?.ok).toBe(false);

    const report = await doctorReport(cwd, { all: true });
    expect(report.checks.map((c) => c.name)).toEqual([
      'stroq',
      'node',
      'rules',
      'self-test',
      'hooks',
      'cursor hooks',
      'codex hooks',
      'copilot hooks',
      'openclaw plugin',
      'windsurf hooks',
      'antigravity hooks',
      'mcp proxy',
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
    expect(
      (await doctorReport(cwd, { all: true })).checks.find((c) => c.name === 'codex hooks')?.ok,
    ).toBe(false);

    installCodexHooks(file, '"/n" "/e.js" hook codex');
    expect((await doctorReport(cwd)).checks.find((c) => c.name === 'codex hooks')?.ok).toBe(true);
    const migrated = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(migrated['PreToolUse']).toBeUndefined();
  });

  it('reports a hooks file whose event value is not an array as not installed', async () => {
    const file = codexHooksPath('project', cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: 'nope' } }));
    const report = await doctorReport(cwd, { all: true });
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
    const copilot = (await doctorReport(cwd, { all: true })).checks.find(
      (c) => c.name === 'copilot hooks',
    )!;
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
    expect(
      (await doctorReport(cwd, { all: true })).checks.find((c) => c.name === 'copilot hooks')?.ok,
    ).toBe(false);
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
    const report = await doctorReport(cwd, { all: true });
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
    const openclaw = (await doctorReport(cwd, { all: true })).checks.find(
      (c) => c.name === 'openclaw plugin',
    )!;
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
    const report = await doctorReport(cwd, { all: true });
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
    const report = await doctorReport(cwd, { all: true });
    expect(report.checks.find((c) => c.name === 'openclaw plugin')?.ok).toBe(false);
    expect(detailOf(report, 'openclaw plugin')).toContain('run-stroq.js');
  });

  it('reports one scope, because OpenClaw plugins are per Gateway host', async () => {
    // No project/user split: there is one directory, and printing two would invite a
    // user to look for a per-repository install that does not exist.
    const detail = detailOf(await doctorReport(cwd, { all: true }), 'openclaw plugin');
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
    const windsurf = (await doctorReport(cwd, { all: true })).checks.find(
      (c) => c.name === 'windsurf hooks',
    )!;
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
    expect(
      (await doctorReport(cwd, { all: true })).checks.find((c) => c.name === 'windsurf hooks')?.ok,
    ).toBe(false);
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
    expect(
      (await doctorReport(cwd, { all: true })).checks.find((c) => c.name === 'windsurf hooks')?.ok,
    ).toBe(false);
  });
});

describe('doctorReport antigravity hooks', () => {
  const detailOf = (
    report: { checks: readonly { name: string; detail: string }[] },
    name: string,
  ) => report.checks.find((c) => c.name === name)?.detail ?? '';
  const cmd = '"/n" "/e.js" hook antigravity';

  it('names the file it looked for when nothing is installed', async () => {
    const antigravity = (await doctorReport(cwd, { all: true })).checks.find(
      (c) => c.name === 'antigravity hooks',
    )!;
    expect(antigravity.ok).toBe(false);
    expect(antigravity.detail).toContain(antigravityHooksPath('project', cwd));
    expect(antigravity.detail).toContain('project: missing');
  });

  it('passes every line once Antigravity alone is installed', async () => {
    installAntigravityHooks(antigravityHooksPath('project', cwd), cmd);
    const report = await doctorReport(cwd);
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(detailOf(report, 'antigravity hooks')).toContain('project: installed');
    expect(detailOf(report, 'hooks')).toBe('not installed (ok: antigravity hooks are)');
  });

  it('reports an entry switched off as not installed', async () => {
    // `enabled: false` leaves the handlers in place and looking correct while
    // Antigravity runs none of them; calling that installed would report protection
    // the file cannot provide.
    const file = antigravityHooksPath('project', cwd);
    installAntigravityHooks(file, cmd);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      stroq: Record<string, unknown>;
    };
    parsed.stroq['enabled'] = false;
    writeFileSync(file, JSON.stringify(parsed));
    expect(
      (await doctorReport(cwd, { all: true })).checks.find((c) => c.name === 'antigravity hooks')
        ?.ok,
    ).toBe(false);
  });

  it('reports a half-install as not installed', async () => {
    // Without `PreInvocation` a taint reaches the model through nothing at all on
    // this agent: `PostToolUse` stdout must be `{}`.
    const file = antigravityHooksPath('project', cwd);
    installAntigravityHooks(file, cmd);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      stroq: Record<string, unknown>;
    };
    delete parsed.stroq['PreInvocation'];
    writeFileSync(file, JSON.stringify(parsed));
    expect(
      (await doctorReport(cwd, { all: true })).checks.find((c) => c.name === 'antigravity hooks')
        ?.ok,
    ).toBe(false);
  });

  it('reports a broken antigravity hooks file without failing the other lines', async () => {
    installHooks(settingsPath('project', cwd), '"/n" "/e.js" hook claude-code');
    const file = antigravityHooksPath('project', cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ not json');
    const report = await doctorReport(cwd);
    expect(report.checks.find((c) => c.name === 'antigravity hooks')?.ok).toBe(false);
    expect(detailOf(report, 'antigravity hooks')).toMatch(/cannot parse/);
    expect(report.checks.find((c) => c.name === 'hooks')?.ok).toBe(true);
  });

  it("ignores a hooks file that only carries someone else's hook", async () => {
    const file = antigravityHooksPath('project', cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ "my-linter-hook": { "PostToolUse": [] } }');
    expect(
      (await doctorReport(cwd, { all: true })).checks.find((c) => c.name === 'antigravity hooks')
        ?.ok,
    ).toBe(false);
  });
});

describe('doctorReport mcp proxy', () => {
  // A real, existing `index.js`: `countWrapped` now checks that a wrapper's recorded
  // entry file still exists, so a fixture path that was never meant to exist (like
  // `/x/dist/index.js` elsewhere in this suite) would wrongly count as stale here.
  const entryDir = mkdtempSync(join(tmpdir(), 'stroq-mcp-entry-'));
  const realEntry = join(entryDir, 'index.js');
  writeFileSync(realEntry, '');
  const wrapOpts = {
    node: '/usr/bin/node',
    entryArgv: [realEntry],
    client: 'claude-code',
    cwd: '/w',
  };

  it('says nothing is installed when no known client config exists', async () => {
    const check = (await doctorReport(cwd, { all: true })).checks.find(
      (c) => c.name === 'mcp proxy',
    );
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('no MCP client config found');
  });

  it('counts the wrapped stdio servers of every config that exists', async () => {
    const file = mcpConfigPath('claude-code', 'project', cwd);
    const wrapped = wrapMcpConfig(
      {
        mcpServers: {
          a: { command: 'x' },
          b: { command: 'y' },
          remote: { url: 'https://mcp.example/sse' },
        },
      },
      wrapOpts,
    );
    writeJsonObject(file, wrapped.config);
    const report = await doctorReport(cwd);
    const check = report.checks.find((c) => c.name === 'mcp proxy');
    expect(check?.ok).toBe(true);
    // HTTP entries are not counted: there is no subprocess to wrap.
    expect(check?.detail).toContain('claude-code: wrapped 2/2 stdio servers');
    expect(check?.detail).toContain(file);
    // A proxy install alone carries every other line, exactly as an agent does.
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });

  it('reports an unwrapped config as not installed and a broken one as an error', async () => {
    const file = mcpConfigPath('claude-code', 'project', cwd);
    writeJsonObject(file, { mcpServers: { a: { command: 'x' } } });
    expect(
      (await doctorReport(cwd, { all: true })).checks.find((c) => c.name === 'mcp proxy')?.detail,
    ).toContain('wrapped 0/1 stdio servers');
    writeFileSync(file, '{ not json');
    const broken = (await doctorReport(cwd, { all: true })).checks.find(
      (c) => c.name === 'mcp proxy',
    );
    expect(broken?.ok).toBe(false);
    expect(broken?.detail).toMatch(/cannot parse/);
  });

  it('reports a stale wrapper whose recorded entry file no longer exists', async () => {
    const file = mcpConfigPath('claude-code', 'project', cwd);
    const wrapped = wrapMcpConfig(
      { mcpServers: { a: { command: 'x' }, b: { command: 'y' } } },
      { ...wrapOpts, entryArgv: ['/does/not/exist/index.js'] },
    );
    writeJsonObject(file, wrapped.config);
    const check = (await doctorReport(cwd, { all: true })).checks.find(
      (c) => c.name === 'mcp proxy',
    );
    // Neither server counts as wrapped — the client would fail to start them — and
    // the detail says why, rather than silently reporting them as protected.
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('wrapped 0/2 stdio servers');
    expect(check?.detail).toContain('2 stale wrappers: entry missing');
  });

  it('names a wrapper that predates env filtering, so the decision is visible', async () => {
    const file = mcpConfigPath('claude-code', 'project', cwd);
    // An install from an older version: still wrapped and still working, but with no
    // recorded pass-list, so its server keeps inheriting the client's whole
    // environment. Nothing breaks it silently; `doctor` is where the user finds out.
    writeJsonObject(file, {
      mcpServers: {
        old: {
          command: '/usr/bin/node',
          args: [
            realEntry,
            'mcp',
            '--server',
            'old',
            '--client',
            'claude-code',
            '--cwd',
            '/w',
            '--',
            'srv',
          ],
        },
      },
    });
    const check = (await doctorReport(cwd, { all: true })).checks.find(
      (c) => c.name === 'mcp proxy',
    );
    expect(check?.detail).toContain('wrapped 1/1 stdio servers');
    expect(check?.detail).toContain('1 inherits the full environment');
  });
});
