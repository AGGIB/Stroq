import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doctorReport } from '../src/commands/doctor.js';
import { installHooks, settingsPath } from '../src/commands/init.js';

const fixture = (): string => mkdtempSync(join(tmpdir(), 'stroq-doctor-'));

describe('doctorReport when no agent carries Stroq', () => {
  it('collapses the per-agent lines into one failing hooks check', async () => {
    const cwd = fixture();
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    const report = await doctorReport(cwd);
    const hookChecks = report.checks.filter(
      (c) => c.name.includes('hook') || c.name.includes('plugin') || c.name === 'mcp proxy',
    );
    expect(hookChecks).toHaveLength(1);
    expect(hookChecks[0]?.name).toBe('hooks');
    expect(hookChecks[0]?.ok).toBe(false);
  });

  it('names only the agents whose config directory exists on this machine', async () => {
    const cwd = fixture();
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    const report = await doctorReport(cwd);
    const detail = report.checks.find((c) => c.name === 'hooks')?.detail ?? '';
    expect(detail).toContain('cursor');
    expect(detail).toContain('stroq init --agent cursor');
    expect(detail).not.toContain('codex');
  });

  it('--all restores every agent line', async () => {
    const cwd = fixture();
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    const report = await doctorReport(cwd, { all: true });
    const names = report.checks.map((c) => c.name);
    expect(names).toContain('cursor hooks');
    expect(names).toContain('codex hooks');
    expect(names).toContain('mcp proxy');
  });

  it('leaves the installed path alone', async () => {
    const cwd = fixture();
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    installHooks(settingsPath('project', cwd), 'stroq hook claude-code');
    const report = await doctorReport(cwd);
    const names = report.checks.map((c) => c.name);
    expect(names).toContain('cursor hooks');
    expect(report.checks.find((c) => c.name === 'cursor hooks')?.ok).toBe(true);
  });

  it('puts the version first', async () => {
    const report = await doctorReport(fixture());
    expect(report.checks[0]?.name).toBe('stroq');
  });
});
