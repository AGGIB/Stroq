import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { doctorReport } from '../../src/commands/doctor.js';
import { installHooks, settingsPath } from '../../src/commands/init.js';

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'stroq-doctor-'));
  process.env['STROQ_HOME'] = join(cwd, 'home');
  process.env['HOME'] = join(cwd, 'fakehome');
});

describe('doctorReport', () => {
  it('reports missing hooks, then installed hooks', () => {
    const before = doctorReport(cwd);
    const byName = (name: string) => before.checks.find((c) => c.name === name)!;
    expect(byName('node').ok).toBe(true);
    expect(byName('rules').ok).toBe(true);
    expect(byName('self-test').ok).toBe(true);
    expect(byName('hooks').ok).toBe(false);
    installHooks(settingsPath('project', cwd), '"/n" "/e.js" hook claude-code');
    expect(doctorReport(cwd).checks.find((c) => c.name === 'hooks')?.ok).toBe(true);
  });
});
