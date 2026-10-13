import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canFire, loadBundledRules } from '@stroq/core';
import {
  agentHookStatus,
  doctorReport,
  rulesDetail,
  runDoctor,
} from '../../src/commands/doctor.js';
import { installCursorHooks, cursorHooksPath } from '../../src/commands/cursor-hooks.js';
import { codexHooksPath, installCodexHooks } from '../../src/commands/codex-hooks.js';
import { copilotHooksPath, installCopilotHooks } from '../../src/commands/copilot-hooks.js';
import {
  devinHooksPath,
  installWindsurfHooks,
  windsurfHooksPath,
} from '../../src/commands/windsurf-hooks.js';
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
import { recordInstall } from '../../src/commands/install-record.js';
import { CLI_ENTRY } from '../helpers/cli-entry.js';

/** A hook command whose Node and entry exist: `doctor` checks that they do. */
const STROQ = `"${process.execPath}" "${CLI_ENTRY}"`;

let cwd: string;
/** A Codex home whose config.toml records `approved` hook approvals. */
function codexHome(approved: boolean): void {
  const dir = join(cwd, 'codex-home');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'config.toml'),
    approved
      ? '[hooks.state."stroq-pre"]\ntrusted_hash = "sha256:aa"\n'
      : '[features]\nhooks = true\n',
  );
  process.env['CODEX_HOME'] = dir;
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'stroq-doctor-'));
  process.env['STROQ_HOME'] = join(cwd, 'home');
  process.env['HOME'] = join(cwd, 'fakehome');
  // Where Windows looks for the home directory: without it the user scope is the machine's own.
  process.env['USERPROFILE'] = join(cwd, 'fakehome');
  codexHome(true);
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
              hooks: [{ type: 'command', command: `${STROQ} hook claude-code`, timeout: 15 }],
            },
          ],
        },
      }),
    );
    const check = (await doctorReport(cwd, { all: true })).checks.find((c) => c.name === 'hooks');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('PreToolUse');
  });

  // A `.claude/settings.json` holding only the user's own permissions is in most
  // projects. "Incomplete" means a Stroq install with events missing; a file with no
  // Stroq entry at all is simply not an install, and must not fail the line for a
  // user who installed Stroq for another agent.
  it('does not call a settings file with no Stroq hook an incomplete install', async () => {
    const file = settingsPath('project', cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
    const check = (await doctorReport(cwd, { all: true })).checks.find((c) => c.name === 'hooks');
    expect(check?.detail).not.toContain('incomplete');
  });

  it('says how many of the rules can fire, and why the others cannot', async () => {
    const check = (await doctorReport(cwd)).checks.find((c) => c.name === 'rules')!;
    const loaded = loadBundledRules();
    const can = loaded.filter(canFire).length;
    expect(check.detail).toBe(rulesDetail(loaded.length, can));
    expect(check.detail).toContain(`${loaded.length} rules loaded, ${can} can fire`);
    expect(can).toBeLessThan(loaded.length);
    expect(check.detail).toContain('what a person typed');
  });

  it('says so plainly when every rule can fire, and names no reason', () => {
    expect(rulesDetail(10, 10)).toBe('10 rules loaded, all can fire on what Stroq reads');
    expect(rulesDetail(10, 7)).toContain('3 need');
  });

  it('reports missing hooks, then installed hooks', async () => {
    const before = await doctorReport(cwd);
    const byName = (name: string) => before.checks.find((c) => c.name === name)!;
    expect(byName('node').ok).toBe(true);
    expect(byName('rules').ok).toBe(true);
    expect(byName('self-test').ok).toBe(true);
    expect(byName('hooks').ok).toBe(false);
    installHooks(settingsPath('project', cwd), `${STROQ} hook claude-code`);
    expect((await doctorReport(cwd)).checks.find((c) => c.name === 'hooks')?.ok).toBe(true);
  });

  // `npx @stroq/cli init` recorded an entry inside npm's npx cache. When npm pruned
  // it, every hook failed to start, the agent treated that as a non-blocking error and
  // ran the call — and this line still said "installed".
  it('fails a hook whose command runs a CLI that no longer exists', async () => {
    const gone = join(cwd, '_npx', 'a1b2', 'node_modules', '@stroq', 'cli', 'dist', 'index.js');
    installHooks(settingsPath('project', cwd), `"${process.execPath}" "${gone}" hook claude-code`);
    const check = (await doctorReport(cwd)).checks.find((c) => c.name === 'hooks');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(gone);
    expect(check?.detail).toMatch(/no longer exists/);
    expect(check?.detail).toContain('stroq init');
    expect(agentHookStatus('claude-code', cwd)?.installed).toBe(false);
  });

  // Before 0.21.2 `init` wrote two events. An install like that keeps working, but it
  // never sees the output of a failed tool, so doctor says so and how to fix it.
  it('calls an install without PostToolUseFailure incomplete and says to re-run init', async () => {
    const file = settingsPath('project', cwd);
    installHooks(file, `${STROQ} hook claude-code`);
    const settings = JSON.parse(readFileSync(file, 'utf8')) as { hooks: Record<string, unknown> };
    delete settings.hooks['PostToolUseFailure'];
    writeFileSync(file, JSON.stringify(settings));
    const check = (await doctorReport(cwd)).checks.find((c) => c.name === 'hooks');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('PostToolUseFailure');
    expect(check?.detail).toContain('stroq init');
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
          afterShellExecution: [{ command: `${STROQ} hook cursor` }],
        },
      }),
    );
    const postOnly = (await doctorReport(cwd, { all: true })).checks.find(
      (c) => c.name === 'cursor hooks',
    );
    expect(postOnly?.ok).toBe(false);
    expect(postOnly?.detail).toContain('beforeShellExecution');
    installCursorHooks(file, `${STROQ} hook cursor`);
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
    installCursorHooks(file, `${STROQ} hook cursor`);
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
    installCursorHooks(cursorHooksPath('project', cwd), `${STROQ} hook cursor`);
    const report = await doctorReport(cwd);
    expect(report.checks.find((c) => c.name === 'cursor hooks')?.ok).toBe(true);
    expect(detailOf(report, 'cursor hooks')).toContain('project: installed');
    // A Cursor-only user must not be told their Claude Code install is broken —
    // and a passing line must not read as a green tick next to the word "missing".
    expect(report.checks.find((c) => c.name === 'hooks')?.ok).toBe(true);
    expect(detailOf(report, 'hooks')).toBe('not installed (ok: cursor hooks are)');
  });

  it('says which agent carries the line when Claude Code alone is installed', async () => {
    installHooks(settingsPath('project', cwd), `${STROQ} hook claude-code`);
    const report = await doctorReport(cwd);
    expect(report.checks.find((c) => c.name === 'cursor hooks')?.ok).toBe(true);
    expect(detailOf(report, 'cursor hooks')).toBe('not installed (ok: hooks are)');
    expect(detailOf(report, 'hooks')).toContain('project: installed');
  });

  it('reports a broken cursor hooks file without failing the Claude Code line', async () => {
    installHooks(settingsPath('project', cwd), `${STROQ} hook claude-code`);
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
    installCodexHooks(codexHooksPath('project', cwd), `${STROQ} hook codex`);
    const report = await doctorReport(cwd);
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(detailOf(report, 'codex hooks')).toContain('project: installed');
    expect(detailOf(report, 'hooks')).toBe('not installed (ok: codex hooks are)');
    expect(detailOf(report, 'cursor hooks')).toBe('not installed (ok: codex hooks are)');
  });

  // A fresh install is a hook Codex has not been told to trust, and it does not run.
  it('fails a Codex install that Codex has not approved yet', async () => {
    codexHome(false);
    installCodexHooks(codexHooksPath('project', cwd), `${STROQ} hook codex`);
    const report = await doctorReport(cwd);
    const codex = report.checks.find((c) => c.name === 'codex hooks')!;
    expect(codex.ok).toBe(false);
    expect(codex.detail).toContain('NOT APPROVED');
    expect(codex.detail).toMatch(/approve/);
  });

  it('names every agent that is carrying the line', async () => {
    installHooks(settingsPath('project', cwd), `${STROQ} hook claude-code`);
    installCursorHooks(cursorHooksPath('project', cwd), `${STROQ} hook cursor`);
    expect(detailOf(await doctorReport(cwd), 'codex hooks')).toBe(
      'not installed (ok: hooks, cursor hooks are)',
    );
  });

  it('reports a broken codex hooks file without failing the other two lines', async () => {
    installHooks(settingsPath('project', cwd), `${STROQ} hook claude-code`);
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
          command: `${STROQ} hook codex`,
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

    installCodexHooks(file, `${STROQ} hook codex`);
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
  const cmd = (phase: string) => `${STROQ} hook copilot ${phase}`;
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
    installHooks(settingsPath('project', cwd), `${STROQ} hook claude-code`);
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
  const cmd = `${STROQ} hook windsurf`;

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
    installHooks(settingsPath('project', cwd), `${STROQ} hook claude-code`);
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

// Devin Desktop, the renamed Windsurf, reads `.devin/hooks.json` first and uses
// `.windsurf/hooks.json` only "when `.devin/hooks.json` is absent or defines no hooks"
// (docs.devin.ai/desktop/cascade/hooks). `init` writes the second one, so a repository's
// own first one switches a project install off without touching a byte of Stroq's file.
describe('doctorReport windsurf hooks beside a project .devin/hooks.json', () => {
  const cmd = `${STROQ} hook windsurf`;
  const foreign = { hooks: { pre_run_command: [{ command: 'echo hi' }] } };
  const put = (file: string, value: unknown): void => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const windsurf = async (opts: { all?: boolean } = { all: true }) =>
    (await doctorReport(cwd, opts)).checks.find((c) => c.name === 'windsurf hooks');
  const detailOf = (
    report: { checks: readonly { name: string; detail: string }[] },
    name: string,
  ) => report.checks.find((c) => c.name === name)?.detail ?? '';

  it('says SHADOWED, and how to fix it, when .devin/hooks.json defines hooks of its own', async () => {
    installWindsurfHooks(windsurfHooksPath('project', cwd), cmd);
    put(devinHooksPath(cwd), foreign);
    const check = await windsurf();
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('project: SHADOWED');
    expect(check?.detail).toContain(devinHooksPath(cwd));
    expect(check?.detail).toContain('stroq init --agent windsurf --user');
    // What `stroq run` asks, so it does not start an agent it believes is guarded.
    expect(agentHookStatus('windsurf', cwd)?.installed).toBe(false);
  });

  it('is not hidden by another agent that is installed', async () => {
    installHooks(settingsPath('project', cwd), `${STROQ} hook claude-code`);
    installWindsurfHooks(windsurfHooksPath('project', cwd), cmd);
    put(devinHooksPath(cwd), foreign);
    const check = await windsurf({});
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('SHADOWED');
  });

  it('is not folded into the not-installed-anywhere line when nothing else is installed', async () => {
    installWindsurfHooks(windsurfHooksPath('project', cwd), cmd);
    put(devinHooksPath(cwd), foreign);
    const check = await windsurf({});
    expect(check).toBeDefined();
    expect(check?.detail).toContain('SHADOWED');
  });

  it('is fine, and still says so, when the user-level file carries Stroq as well', async () => {
    // The user file has no Devin twin and the levels are merged, so it cannot be replaced
    // from the repository. Windows reads USERPROFILE, not HOME.
    const profile = process.env['USERPROFILE'];
    process.env['USERPROFILE'] = process.env['HOME'];
    try {
      installWindsurfHooks(windsurfHooksPath('project', cwd), cmd);
      installWindsurfHooks(windsurfHooksPath('user', cwd), cmd);
      put(devinHooksPath(cwd), foreign);
      const check = await windsurf();
      expect(check?.ok).toBe(true);
      expect(check?.detail).toContain('project: SHADOWED');
      expect(check?.detail).toContain('user: installed');
    } finally {
      if (profile === undefined) delete process.env['USERPROFILE'];
      else process.env['USERPROFILE'] = profile;
    }
  });

  it('does not call it shadowed when .devin/hooks.json defines no hook', async () => {
    installWindsurfHooks(windsurfHooksPath('project', cwd), cmd);
    for (const text of ['', '{}', '{ "hooks": {} }', '{ "hooks": { "pre_run_command": [] } }']) {
      put(devinHooksPath(cwd), text);
      const check = await windsurf();
      expect(check?.ok, text).toBe(true);
      expect(check?.detail, text).toContain('project: installed');
      expect(check?.detail, text).not.toContain('SHADOWED');
    }
  });

  it('says nothing about it when Stroq is not installed in the project at all', async () => {
    put(devinHooksPath(cwd), foreign);
    const check = await windsurf();
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('project: missing');
    expect(check?.detail).not.toContain('SHADOWED');
  });

  // The suffix ` hook windsurf` is what a hook command ends in, not who wrote it, and the
  // file is the repository's: its entries count as Stroq's only when they are the command
  // `stroq init` recorded, and the paths in it are still there.
  describe("entries in .devin/hooks.json that only look like Stroq's", () => {
    const forged = (n = 6) => {
      const events = [
        'pre_read_code',
        'post_read_code',
        'pre_write_code',
        'pre_run_command',
        'pre_mcp_tool_use',
        'post_mcp_tool_use',
      ];
      return {
        hooks: Object.fromEntries(
          events.slice(0, n).map((e) => [e, [{ command: '/tmp/evil hook windsurf' }]]),
        ),
      };
    };

    it('are shadowing hooks, not the install, when the command is not the recorded one', async () => {
      installWindsurfHooks(windsurfHooksPath('project', cwd), cmd);
      recordInstall('windsurf', 'project', cmd);
      put(devinHooksPath(cwd), forged());
      const check = await windsurf();
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain('SHADOWED');
      expect(check?.detail).toContain('not the command stroq init recorded');
      expect(agentHookStatus('windsurf', cwd)?.installed).toBe(false);
    });

    it('do not make a project with no install look installed', async () => {
      put(devinHooksPath(cwd), forged());
      const check = await windsurf();
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain('project: missing');
      expect(agentHookStatus('windsurf', cwd)?.installed).toBe(false);
    });

    it("do not make another agent's line say Windsurf is carrying the load", async () => {
      installHooks(settingsPath('project', cwd), `${STROQ} hook claude-code`);
      put(devinHooksPath(cwd), forged());
      const report = await doctorReport(cwd);
      expect(detailOf(report, 'hooks')).not.toContain('windsurf');
    });

    it('are not the install when they are the recorded command but its paths are gone', async () => {
      const gone = '"/nonexistent/node" "/nonexistent/stroq.js" hook windsurf';
      installWindsurfHooks(windsurfHooksPath('project', cwd), gone);
      recordInstall('windsurf', 'project', gone);
      installWindsurfHooks(devinHooksPath(cwd), gone);
      const check = await windsurf();
      expect(check?.ok).toBe(false);
      expect(agentHookStatus('windsurf', cwd)?.installed).toBe(false);
    });
  });

  // A check that the recorded command appears somewhere in the text, and another that six
  // commands end in ` hook windsurf`, are two answers about two different things: neither says
  // that each of the six events runs the entry Stroq wrote. The file is the repository's.
  describe('a .devin/hooks.json built to pass the checks it can see', () => {
    const events = [
      'pre_read_code',
      'post_read_code',
      'pre_write_code',
      'pre_run_command',
      'pre_mcp_tool_use',
      'post_mcp_tool_use',
    ];
    const everyEvent = (entry: unknown, extra: Record<string, unknown> = {}) => ({
      ...extra,
      hooks: Object.fromEntries(events.map((e) => [e, [entry]])),
    });
    const real = (): { command: string; powershell: string; show_output: boolean } => ({
      command: cmd,
      powershell: `& ${cmd}`,
      show_output: true,
    });
    const shadowed = async (devinFile: unknown): Promise<void> => {
      installWindsurfHooks(windsurfHooksPath('project', cwd), cmd);
      recordInstall('windsurf', 'project', cmd);
      put(devinHooksPath(cwd), devinFile);
      const check = await windsurf();
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain('SHADOWED');
      expect(agentHookStatus('windsurf', cwd)?.installed).toBe(false);
    };

    it('with the recorded command in a note and no-ops in the six events', async () => {
      await shadowed(everyEvent({ command: '/usr/bin/true hook windsurf' }, { note: cmd }));
    });

    it('with the real entry on one event and no-ops on the other five', async () => {
      const file = everyEvent({ command: '/usr/bin/true hook windsurf' });
      (file.hooks as Record<string, unknown[]>)['pre_run_command'] = [real()];
      await shadowed(file);
    });

    it('with the recorded command only in the PowerShell field', async () => {
      await shadowed(
        everyEvent({ command: '/usr/bin/true hook windsurf', powershell: `& ${cmd}` }),
      );
    });

    it("with the real command and a working directory of the repository's choosing", async () => {
      await shadowed(everyEvent({ ...real(), working_directory: '/tmp' }));
    });

    it('with the real command and a key Stroq never writes', async () => {
      await shadowed(everyEvent({ ...real(), env: { PATH: '/tmp/bin' } }));
    });
  });

  it('counts a faithful copy of the recorded entries in .devin/hooks.json as the install that runs', async () => {
    installWindsurfHooks(windsurfHooksPath('project', cwd), cmd);
    recordInstall('windsurf', 'project', cmd);
    installWindsurfHooks(devinHooksPath(cwd), cmd);
    const check = await windsurf();
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain(devinHooksPath(cwd));
    expect(agentHookStatus('windsurf', cwd)?.installed).toBe(true);
  });

  it('names the command that fixes a shadowed install, so no caller suggests the one that does not', async () => {
    installWindsurfHooks(windsurfHooksPath('project', cwd), cmd);
    put(devinHooksPath(cwd), foreign);
    expect(agentHookStatus('windsurf', cwd)?.fix).toBe('stroq init --agent windsurf --user');
    expect(agentHookStatus('cursor', cwd)?.fix).toBe('stroq init --agent cursor');
    expect(agentHookStatus('claude-code', cwd)?.fix).toBe('stroq init --agent claude-code');
  });

  it('fails with the reason when .devin/hooks.json cannot be read, since whether Stroq runs is unknown', async () => {
    installWindsurfHooks(windsurfHooksPath('project', cwd), cmd);
    put(devinHooksPath(cwd), '{ "hooks": the-secret-token-value');
    const check = await windsurf();
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('cannot parse');
    expect(check?.detail).toContain(devinHooksPath(cwd));
    expect(check?.detail).not.toContain('the-secret-token-value');
    expect(agentHookStatus('windsurf', cwd)?.installed).toBe(false);
  });
});

describe('doctorReport antigravity hooks', () => {
  const detailOf = (
    report: { checks: readonly { name: string; detail: string }[] },
    name: string,
  ) => report.checks.find((c) => c.name === name)?.detail ?? '';
  // A line with a quote in it cannot start under Antigravity on Windows, and `init` writes none there.
  const cmd =
    process.platform === 'win32'
      ? `${process.execPath} ${CLI_ENTRY} hook antigravity`
      : `${STROQ} hook antigravity`;

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
    installHooks(settingsPath('project', cwd), `${STROQ} hook claude-code`);
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

// The hook line without a quote, which `init` writes for the hosts that hand it to cmd.exe, and the one with
// quotes that Antigravity on Windows cannot start. Its paths are files made for the test: the node and the build
// that run it can stand where a bare word cannot name them (a blank in `Program Files`), and a test that read them
// would pass for the wrong reason there. A temporary directory with a blank in it cannot hold them either.
describe.skipIf(/\s/.test(tmpdir()))('doctorReport, a hook line written without quotes', () => {
  /** An empty file of this name in a directory of the test, which exists for `doctor` to find. */
  const place = (name: string): string => {
    const file = join(cwd, 'bare', name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
    return file;
  };
  const bare = (agent: string, entry: string = place('index.js'), node: string = place('node')) =>
    `${node} ${entry} hook ${agent}`;
  const hooksCheck = async () => (await doctorReport(cwd)).checks.find((c) => c.name === 'hooks');

  it('is installed, when the node and the entry it names exist', async () => {
    installHooks(settingsPath('project', cwd), bare('claude-code'));

    const check = await hooksCheck();

    expect(check?.ok).toBe(true);
    expect(agentHookStatus('claude-code', cwd)?.installed).toBe(true);
  });

  it('is broken, and names the entry, when the entry has gone', async () => {
    const gone = join(cwd, 'gone', 'dist', 'index.js');
    installHooks(settingsPath('project', cwd), bare('claude-code', gone));

    const check = await hooksCheck();

    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(gone);
    expect(check?.detail).toMatch(/no longer exists/);
  });

  it('is broken, and names the node, when the node has gone', async () => {
    const node = join(cwd, 'gone', 'node');
    installHooks(settingsPath('project', cwd), bare('claude-code', undefined, node));

    const check = await hooksCheck();

    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(node);
  });

  it('does not look for a bare `node`, which the search path finds', async () => {
    installHooks(settingsPath('project', cwd), `node ${place('index.js')} hook claude-code`);

    expect((await hooksCheck())?.ok).toBe(true);
  });

  it.each([
    'npx @stroq/cli hook claude-code',
    'bash ./scripts/guard.sh hook claude-code',
    'node ./node_modules/@stroq/cli/dist/index.js hook claude-code',
    'node %APPDATA%\\npm\\node_modules\\@stroq\\cli\\dist\\index.js hook claude-code',
    'node ~/stroq/dist/index.js hook claude-code',
  ])(
    'does not call a hook broken for a relative word that is no place `doctor` can look for: %s',
    async (line) => {
      // Somebody else's hook or one resolved from the agent's own directory; a path `init` wrote is absolute.
      installHooks(settingsPath('project', cwd), line);

      const check = await hooksCheck();

      expect(check?.ok).toBe(true);
      expect(check?.detail).not.toMatch(/no longer exists/);
    },
  );

  it('does not read the `&` of a PowerShell entry as the node, nor what follows as the entry', async () => {
    installCopilotHooks(
      copilotHooksPath('project', cwd),
      `/tmp/evil hook copilot pre`,
      `/tmp/evil hook copilot post`,
    );

    const status = agentHookStatus('copilot', cwd);

    // Read as the entry of a hook that someone has rewritten (which `drift` is for, and the exposure tests
    // look at), not as a place that has gone: `/tmp/evil` is no node and no entry here.
    expect(status?.installed).toBe(true);
    expect(status?.detail).not.toMatch(/no longer exists/);
  });

  it('does not take a hook of the same words in some other program for broken', async () => {
    // `python3 lint.py hook antigravity pre` names no place, and so none that has gone.
    installAntigravityHooks(antigravityHooksPath('project', cwd), bare('antigravity'));
    const file = antigravityHooksPath('project', cwd);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    parsed['my-linter'] = {
      PostToolUse: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: 'python3 lint.py hook antigravity pre' }],
        },
      ],
    };
    writeFileSync(file, JSON.stringify(parsed));

    const report = await doctorReport(cwd, { all: true });

    expect(report.checks.find((c) => c.name === 'antigravity hooks')?.ok).toBe(true);
  });
});

describe('doctorReport, Antigravity on Windows', () => {
  const quoted = `"${process.execPath}" "${CLI_ENTRY}" hook antigravity`;
  const bare = `${process.execPath} ${CLI_ENTRY} hook antigravity`;

  async function onPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...original, value: platform });
    try {
      return await fn();
    } finally {
      if (original !== undefined) Object.defineProperty(process, 'platform', original);
    }
  }

  /** What the Antigravity line of the report says, with `--all` as the plain report has it. */
  async function antigravityLine(platform: NodeJS.Platform, all = true): Promise<string> {
    const report = await onPlatform(platform, () => doctorReport(cwd, { all }));
    const check = report.checks.find((c) => c.name === 'antigravity hooks');
    return `${check?.ok ? 'ok' : 'fail'}: ${check?.detail ?? ''}`;
  }

  it('calls a line with a quote in it broken, and says what to do from outside Antigravity', async () => {
    installAntigravityHooks(antigravityHooksPath('project', cwd), quoted);

    const said = await antigravityLine('win32');

    expect(said).toMatch(/^fail: /);
    expect(said).toContain('has a quote in it');
    expect(said).toContain('cmd.exe');
    expect(said).toContain('blocks every tool call');
    expect(said).toContain('stroq init --agent antigravity');
    expect(said).toContain('stroq uninstall --agent antigravity');
    expect(said).toContain('outside Antigravity');
  });

  it('says it in the plain report too, where nothing else is installed, and not "not installed in any agent"', async () => {
    installAntigravityHooks(antigravityHooksPath('project', cwd), quoted);

    const report = await onPlatform('win32', () => doctorReport(cwd));

    // The collapsed line is a single `hooks` row that says "not installed in any agent"; the rows of the agents are
    // what a broken install keeps in the report.
    expect(report.checks.map((c) => c.detail).join('\n')).not.toContain(
      'not installed in any agent',
    );
    expect(report.checks.find((c) => c.name === 'antigravity hooks')?.detail).toContain(
      'has a quote in it',
    );
  });

  it('does not let another agent that is installed make it green', async () => {
    installHooks(settingsPath('project', cwd), `${STROQ} hook claude-code`);
    installAntigravityHooks(antigravityHooksPath('project', cwd), quoted);

    const said = await antigravityLine('win32', false);

    // "not installed (ok: hooks are)" is what a missing agent says beside a working one; this one is not missing.
    expect(said).toMatch(/^fail: /);
    expect(said).toContain('has a quote in it');
  });

  it('names the command that takes the hook out for the user scope too', async () => {
    installAntigravityHooks(antigravityHooksPath('user', cwd), quoted);

    const said = await antigravityLine('win32');

    expect(said).toContain('stroq uninstall --agent antigravity --user');
  });

  it('is not installed for a caller that asks about the agent alone, as `stroq run` does', async () => {
    installAntigravityHooks(antigravityHooksPath('project', cwd), quoted);

    const status = await onPlatform('win32', async () => agentHookStatus('antigravity', cwd));

    expect(status?.installed).toBe(false);
    expect(status?.detail).toContain('has a quote in it');
  });

  it('calls a line without a quote installed', async () => {
    installAntigravityHooks(antigravityHooksPath('project', cwd), bare);

    expect(await antigravityLine('win32')).toMatch(/^ok: .*project: installed/);
  });

  it.each(['linux', 'darwin'] as const)(
    'leaves the line with a quote alone on %s',
    async (platform) => {
      installAntigravityHooks(antigravityHooksPath('project', cwd), quoted);

      expect(await antigravityLine(platform)).toMatch(/^ok: .*project: installed/);
    },
  );
});
