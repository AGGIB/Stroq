import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { agentHookStatus, doctorReport } from '../../src/commands/doctor.js';
import { withLiveness } from '../../src/commands/doctor-liveness.js';
import { cursorHooksPath, installCursorHooks } from '../../src/commands/cursor-hooks.js';
import { installHooks, settingsPath } from '../../src/commands/init.js';
import { writeJsonObject } from '../../src/commands/config-file.js';
import { recordInstall } from '../../src/commands/install-record.js';
import { mcpConfigPath, wrapMcpConfig } from '../../src/commands/mcp-config.js';
import { stampHookFired } from '../../src/hook-stamp.js';
import { CLI_ENTRY } from '../helpers/cli-entry.js';

/**
 * `doctor` said a hook was installed when a file said so. A host that has switched hooks off, or
 * one whose approval no longer matches, runs nothing, and the line was green all the same: a
 * firewall that silently does nothing. The line now also says when the host last called Stroq.
 * It is a fact and not a verdict: a fresh install has not been called yet, so it does not fail
 * the check.
 */
const STROQ = `"${process.execPath}" "${CLI_ENTRY}"`;
const NOW = Date.parse('2026-10-06T10:03:20.000Z');

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'stroq-doctor-live-'));
  process.env['STROQ_HOME'] = join(cwd, 'home');
  process.env['HOME'] = join(cwd, 'fakehome');
});

const detailOf = async (name: string, all = false): Promise<string> =>
  (await doctorReport(cwd, { now: NOW, all })).checks.find((c) => c.name === name)?.detail ?? '';

describe('doctorReport says when the host last called the hook', () => {
  it('says nothing was recorded for an install that has not been called yet', async () => {
    installHooks(settingsPath('project', cwd), `${STROQ} hook claude-code`);
    const report = await doctorReport(cwd, { now: NOW });
    const check = report.checks.find((c) => c.name === 'hooks');
    expect(check?.detail).toMatch(/ · no hook call recorded on this machine yet$/);
    // A fresh install has not been used, and a line that fails for that would be noise.
    expect(check?.ok).toBe(true);
  });

  it('says how long ago it did, and that the time is the machine’s and not the project’s', async () => {
    installHooks(settingsPath('project', cwd), `${STROQ} hook claude-code`);
    stampHookFired('claude-code', new Date('2026-10-06T10:00:00.000Z'));
    expect(await detailOf('hooks')).toMatch(/ · last hook call on this machine 3 min ago$/);
  });

  it('keeps each agent’s own time', async () => {
    installHooks(settingsPath('project', cwd), `${STROQ} hook claude-code`);
    installCursorHooks(cursorHooksPath('project', cwd), `${STROQ} hook cursor`);
    stampHookFired('claude-code', new Date('2026-10-06T10:02:20.000Z'));
    stampHookFired('cursor', new Date('2026-10-06T07:00:00.000Z'));
    expect(await detailOf('hooks')).toMatch(/ · last hook call on this machine 1 min ago$/);
    expect(await detailOf('cursor hooks')).toMatch(/ · last hook call on this machine 3 h ago$/);
  });

  it('is not moved by another agent’s call', async () => {
    installHooks(settingsPath('project', cwd), `${STROQ} hook claude-code`);
    stampHookFired('cursor', new Date('2026-10-06T10:03:00.000Z'));
    expect(await detailOf('hooks')).toMatch(/ · no hook call recorded on this machine yet$/);
  });

  it('leaves an agent that is not installed alone', async () => {
    installHooks(settingsPath('project', cwd), `${STROQ} hook claude-code`);
    stampHookFired('cursor', new Date('2026-10-06T10:03:00.000Z'));
    expect(await detailOf('cursor hooks')).toBe('not installed (ok: hooks are)');
  });

  describe('a stamp that is ahead of the clock', () => {
    const stampAt = (iso: string): void => {
      installHooks(settingsPath('project', cwd), `${STROQ} hook claude-code`);
      stampHookFired('claude-code', new Date(iso));
    };

    // Two clocks differ by a moment; the host wrote this a second ago by its own.
    it('is a call that has just been made, within a few minutes', async () => {
      stampAt('2026-10-06T10:06:00.000Z');
      expect(await detailOf('hooks')).toMatch(/ · last hook call on this machine just now$/);
    });

    // A dead host never overwrites it, and that is the case the line exists for.
    it.each(['2026-10-07T10:03:20.000Z', '2999-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z'])(
      'is not a call that has just been made, further ahead than that (%s)',
      async (iso) => {
        stampAt(iso);
        const detail = await detailOf('hooks');
        expect(detail).toMatch(/ · last hook call is dated in the future \(check the clock\)$/);
        expect(detail).not.toContain('just now');
      },
    );
  });

  // `doctor` read the stamp with a plain `readFileSync`, which waits for a writer on a FIFO and
  // prints nothing until it is done. The real command, bounded, so that a regression fails the test
  // and does not hold the suite.
  it.skipIf(process.platform === 'win32')(
    'is not held by a FIFO planted where the stamp is read',
    () => {
      installHooks(settingsPath('project', cwd), `${STROQ} hook claude-code`);
      const stampDir = join(cwd, 'home', 'last-hook');
      mkdirSync(stampDir, { recursive: true });
      execFileSync('mkfifo', [join(stampDir, 'claude-code')]);
      const run = spawnSync(process.execPath, [CLI_ENTRY, 'doctor'], {
        cwd,
        env: { ...process.env, STROQ_HOME: join(cwd, 'home'), HOME: join(cwd, 'fakehome') },
        encoding: 'utf8',
        timeout: 45_000,
      });
      expect(run.signal).toBeNull();
      expect(run.stdout).toContain('installed');
      expect(run.stdout).toContain('no hook call recorded on this machine yet');
    },
    60_000,
  );

  // The proxy row has no adapter and is no hook. With no client config at all it is not installed
  // and gets nothing anyway, so the test installs a real proxy: only then the row is whole.
  it('does not put it on the MCP proxy, which is no hook', async () => {
    // A wrapper counts when the entry it records exists and is named like Stroq's own.
    const entry = join(cwd, 'index.js');
    writeFileSync(entry, '');
    const wrapped = wrapMcpConfig(
      { mcpServers: { a: { command: 'x' } } },
      { node: '/usr/bin/node', entryArgv: [entry], client: 'claude-code', cwd: '/w' },
    );
    writeJsonObject(mcpConfigPath('claude-code', 'project', cwd), wrapped.config);
    const report = await doctorReport(cwd, { now: NOW, all: true });
    const row = report.checks.find((c) => c.name === 'mcp proxy');
    expect(row?.ok).toBe(true);
    expect(row?.detail).toContain('wrapped 1/1 stdio servers');
    expect(row?.detail).not.toContain('hook call');
  });

  // The line for an install that is broken has something more urgent to say.
  it('does not add it to an install whose hook has vanished', async () => {
    const gone = join(cwd, '_npx', 'a1b2', 'node_modules', '@stroq', 'cli', 'dist', 'index.js');
    installHooks(settingsPath('project', cwd), `"${process.execPath}" "${gone}" hook claude-code`);
    stampHookFired('claude-code', new Date('2026-10-06T10:00:00.000Z'));
    expect(await detailOf('hooks')).not.toContain('hook call');
  });

  // The other way a line can be installed and not whole: the entry is no longer what `init` wrote.
  // That the host calls it only makes it worse, and the line says what changed instead.
  it('does not add it to an install whose entry is no longer the command init wrote', async () => {
    installHooks(settingsPath('project', cwd), `${STROQ} hook claude-code`);
    recordInstall('claude-code', 'project', `${STROQ} hook claude-code --as-written`);
    stampHookFired('claude-code', new Date('2026-10-06T10:00:00.000Z'));
    const report = await doctorReport(cwd, { now: NOW });
    const check = report.checks.find((c) => c.name === 'hooks');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('CHANGED');
    expect(check?.detail).not.toContain('hook call');
  });

  // `stroq run` and `stroq exposure` ask for the install, not for the host's history.
  it('is not part of what agentHookStatus reports', () => {
    installHooks(settingsPath('project', cwd), `${STROQ} hook claude-code`);
    stampHookFired('claude-code');
    expect(agentHookStatus('claude-code', cwd)?.detail).not.toContain('hook call');
  });
});

describe('withLiveness', () => {
  const whole = { name: 'hooks', ok: true, detail: 'project: installed' };

  it('adds the time to a whole install', () => {
    stampHookFired('claude-code', new Date(NOW - 60_000));
    expect(withLiveness(whole, 'claude-code', true, NOW).detail).toBe(
      'project: installed · last hook call on this machine 1 min ago',
    );
  });

  it.each([
    ['one that is not installed', whole, 'claude-code', false],
    ['one that fails the check', { ...whole, ok: false }, 'claude-code', true],
    ['the MCP proxy', whole, 'mcp', true],
  ])('leaves %s as it is', (_, check, agent, installed) => {
    expect(withLiveness(check, agent, installed, NOW)).toBe(check);
  });

  it('keeps what else the check held', () => {
    const check = { name: 'hooks', ok: true, detail: 'x', extra: 7 };
    expect(withLiveness(check, 'claude-code', true, NOW)).toMatchObject({
      name: 'hooks',
      extra: 7,
    });
  });
});
