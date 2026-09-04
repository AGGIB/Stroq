import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { doctorReport, runDoctor } from '../../src/commands/doctor.js';
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
