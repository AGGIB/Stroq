import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { doctorReport, runDoctor } from '../../src/commands/doctor.js';
import { installCursorHooks, cursorHooksPath } from '../../src/commands/cursor-hooks.js';
import { codexHooksPath, installCodexHooks } from '../../src/commands/codex-hooks.js';
import { installHooks, settingsPath } from '../../src/commands/init.js';
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

  it('reports three agents and fails all three lines when none is installed', async () => {
    const report = await doctorReport(cwd);
    expect(report.checks.map((c) => c.name)).toEqual([
      'node',
      'rules',
      'self-test',
      'hooks',
      'cursor hooks',
      'codex hooks',
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
