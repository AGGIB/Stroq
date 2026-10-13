import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_POLICY } from '@stroq/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { cursorHooksPath, installCursorHooks } from '../../src/commands/cursor-hooks.js';
import { doctorReport } from '../../src/commands/doctor.js';
import { withProof } from '../../src/commands/doctor-proof.js';
import { installHooks, settingsPath } from '../../src/commands/init.js';
import { recordInstall } from '../../src/commands/install-record.js';
import { stampHookFired } from '../../src/hook-stamp.js';
import { policySha256 } from '../../src/live/policy-digest.js';
import { writeHostResult } from '../../src/live/store.js';
import type { HostResult } from '../../src/live/types.js';
import { liveResultFileIn } from '../../src/paths.js';
import { stroqVersion } from '../../src/version.js';
import { CLI_ENTRY } from '../helpers/cli-entry.js';
import { resultOf } from '../live/helpers.js';

/**
 * `stroq doctor` says what the stored live check found, on the line of an install that is whole: a
 * `proof:` that is read from one small file and never runs the host, so it stays fast and offline. What it
 * cannot see is a host that was updated since (it does not ask the host), and it says so.
 */
const STROQ = `"${process.execPath}" "${CLI_ENTRY}"`;
const NOW = Date.parse('2026-10-12T10:00:00.000Z');

let cwd: string;
let home: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'stroq-doctor-proof-'));
  home = join(cwd, 'home');
  process.env['STROQ_HOME'] = home;
  process.env['HOME'] = join(cwd, 'fakehome');
  process.env['USERPROFILE'] = join(cwd, 'fakehome');
});

const install = (): void => {
  installHooks(settingsPath('project', cwd), `${STROQ} hook claude-code`);
};

/** A stored result as a check against today's Stroq and the default policy would have left it. */
const store = (over: Partial<HostResult> = {}): void => {
  writeHostResult(
    home,
    resultOf('verified', {
      stroqVersion: stroqVersion(),
      policySha256: policySha256(DEFAULT_POLICY),
      at: '2026-10-10T01:02:03.456Z',
      ...over,
    }),
  );
};

const detailOf = async (name = 'hooks'): Promise<string> =>
  (await doctorReport(cwd, { now: NOW, all: true })).checks.find((c) => c.name === name)?.detail ??
  '';

describe('the proof on the line of a whole install', () => {
  it('says there is no live check yet, and the command that makes one', async () => {
    install();
    expect(await detailOf()).toContain(' · proof: no live check yet (stroq prove)');
  });

  it('puts the proof before the time of the last call, so that the line still ends on the call', async () => {
    install();
    stampHookFired('claude-code', new Date(NOW - 60_000));
    const detail = await detailOf();
    expect(detail.indexOf('proof:')).toBeLessThan(detail.indexOf('last hook call'));
    expect(detail).toMatch(/ · last hook call on this machine 1 min ago$/);
  });

  it('does not fail the line for it: a check that has not been run is not a fault', async () => {
    install();
    const check = (await doctorReport(cwd, { now: NOW })).checks.find((c) => c.name === 'hooks');
    expect(check?.ok).toBe(true);
  });

  it('says when it was verified, against which host', async () => {
    install();
    store();
    expect(await detailOf()).toContain(
      ' · proof: verified (checked 2026-10-10 against 2.1.271: a denied action was stopped',
    );
  });

  it('says it is stale when Stroq is not the Stroq that checked', async () => {
    install();
    store({ stroqVersion: '0.1.0' });
    const detail = await detailOf();
    expect(detail).toMatch(/proof: stale \(checked 2026-10-10, but Stroq 0\.1\.0 is now /);
    expect(detail).toContain('run stroq prove again');
  });

  it('says it is stale when the policy is not the policy that was checked', async () => {
    install();
    store({ policySha256: 'b'.repeat(64) });
    expect(await detailOf()).toMatch(/proof: stale \(checked 2026-10-10, but the policy changed/);
  });

  it('says it is stale when the hook was installed again after the check', async () => {
    install();
    store();
    recordInstall('claude-code', 'project', `${STROQ} hook claude-code`);
    expect(await detailOf()).toMatch(/proof: stale \(.*installed again after the check/);
  });

  it('says a failure, whatever has changed since', async () => {
    install();
    store({
      ...resultOf('failed'),
      stroqVersion: stroqVersion(),
      policySha256: policySha256(DEFAULT_POLICY),
    });
    expect(await detailOf()).toMatch(/proof: failed \(the live check of 2026-10-10 failed: /);
  });

  it('says it did not look at the host since, which is the one thing it cannot see', async () => {
    install();
    store();
    expect(await detailOf()).toContain('host version not re-read');
  });

  it('shows the caveats of the result, as the result says them', async () => {
    install();
    store({ caveats: ['hook-trust-bypassed'] });
    expect(await detailOf()).toContain('hook-trust-bypassed');
  });

  it('does not take what a stand-in said for the proof of the host', async () => {
    install();
    store({ mode: 'stand-in' });
    expect(await detailOf()).toContain('proof: no live check yet');
  });

  it('says the stored result cannot be read, when it cannot, without repeating what the file said', async () => {
    install();
    mkdirSync(join(home, 'live'), { recursive: true });
    writeFileSync(
      liveResultFileIn(home, 'claude-code'),
      '{"version":1,"hostVersion":"\\u001b[31mevil"',
    );
    const detail = await detailOf();
    expect(detail).toMatch(/proof: the stored result cannot be read \(not JSON\); run stroq prove/);
    expect(detail).not.toContain('evil');
  });

  it('says the policy cannot be read, when it cannot', async () => {
    install();
    store();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'policy.yaml'), 'rules: [this is not a policy');
    expect(await detailOf()).toMatch(/proof: .*policy.*cannot be read/);
  });
});

describe('where there is no proof to show', () => {
  it('says a host with no headless mode is unsupported, in the words of the table of hosts', async () => {
    installCursorHooks(cursorHooksPath('project', cwd), `${STROQ} hook cursor`);
    expect(await detailOf('cursor hooks')).toContain(
      ' · proof: unsupported (no verified headless hook mode)',
    );
  });

  it('says a host that could be driven and has no driver yet is not available, not "no live check yet"', () => {
    const check = { name: 'future hooks', ok: true, detail: 'project: installed' };
    const shown = withProof(check, 'future', { installed: true, changed: false }, NOW);
    expect(shown.detail).toBe(
      'project: installed · proof: not available yet (stroq prove has no driver for future)',
    );
  });

  it('says nothing for an install that is not whole', async () => {
    // Not installed at all.
    store();
    expect(await detailOf()).not.toContain('proof:');
  });

  it('leaves a check that fails as it is', () => {
    const check = { name: 'hooks', ok: false, detail: 'project: missing' };
    expect(withProof(check, 'claude-code', { installed: true, changed: false }, NOW)).toBe(check);
  });

  it('leaves the MCP proxy alone', () => {
    const check = { name: 'mcp proxy', ok: true, detail: 'wrapped' };
    expect(withProof(check, 'mcp', { installed: true, changed: false }, NOW)).toBe(check);
  });
});
