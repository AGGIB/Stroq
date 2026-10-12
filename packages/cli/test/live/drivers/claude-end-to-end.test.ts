import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hookCommand } from '../../../src/commands/hook-command.js';
import { openLedger } from '../../../src/live/budget.js';
import { createClaudeDriver } from '../../../src/live/drivers/claude.js';
import { ALLOW_FILE } from '../../../src/live/probes.js';
import type { HostResult } from '../../../src/live/types.js';
import { verifyHost } from '../../../src/live/verify.js';
import { CLI_ENTRY } from '../../helpers/cli-entry.js';
import { makeRig, type Rig } from '../rig.js';
import { marksOf, verifyOptions } from '../verify-harness.js';
import {
  canMakeFakeClaude,
  isAlive,
  makeFakeClaude,
  type Behaviour,
  type FakeClaude,
} from './fake-claude.js';

/**
 * The driver, the real hook and `verifyHost` together, against a stand-in for the host that runs the hook
 * line it is given (`fake-claude-emulator.ts`). What this shows is that the pieces fit: that the settings the
 * driver hands the host make it call the hook with the throwaway directories, that the audit log and the
 * files are where the check looks, and that a run ends as the evidence says. What it cannot show is what the
 * real Claude Code does with a hook: that is the fixtures' and the live run's.
 */
let rig: Rig;
let fake: FakeClaude;
let tools: string;
beforeEach(() => {
  rig = makeRig(false);
  fake = makeFakeClaude();
  // `curl` is a stub that fails the way an unresolvable host does: the egress probe makes no request.
  tools = mkdtempSync(join(tmpdir(), 'stroq-fake-tools-'));
  const curl = join(tools, 'curl');
  writeFileSync(curl, '#!/bin/sh\nexit 6\n');
  chmodSync(curl, 0o755);
  mkdirSync(join(rig.root, 'host-home'));
});
afterEach(() => {
  fake.cleanup();
  rig.cleanup();
  rmSync(tools, { recursive: true, force: true });
});

const ENV = (): Record<string, string> => ({
  PATH: `${tools}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
  HOME: join(rig.root, 'host-home'),
});

/** The driver with the line `stroq init` writes for Claude Code, run by the built CLI. */
const driver = () =>
  createClaudeDriver({
    hookLine: hookCommand(process.execPath, CLI_ENTRY, 'claude-code'),
    bin: fake.bin,
    killGraceMs: 500,
  });

/** A whole check, with the environment this test hands the host. */
const check = (options: { readonly maxRequests?: number } = {}): Promise<HostResult> =>
  verifyHost(
    driver(),
    rig.ctx({ env: ENV(), deadlineMs: 60_000 }),
    verifyOptions({ ledger: openLedger({ memory: true, limit: 30 }), graceMs: 5_000, ...options }),
  );

const behave = (emulate: NonNullable<Behaviour['emulate']>): void => fake.script([{ emulate }]);

describe.skipIf(!canMakeFakeClaude())('the Claude driver, the real hook and verifyHost', () => {
  it('verifies a host that obeys the hook, in the five requests of a full check', async () => {
    behave({ protectGit: true });
    const result = await check();
    // The git-hook probe is stopped by the host's own permission step in its control, as on the real host.
    expect(marksOf(result)).toEqual({
      allow: 'passed:ran',
      'secret-egress': 'passed:blocked',
      'secret-egress:control': 'passed:armed',
      deny: 'inconclusive:probe-not-armed',
      'deny:control': 'inconclusive:probe-not-armed',
    });
    expect(result.state).toBe('verified');
    expect(result.hostVersion).toBe('2.1.271');
    expect(fake.calls()).toHaveLength(5);
    const stopped = result.probes.find((p) => p.id === 'secret-egress');
    expect(stopped?.evidence).toEqual({ E1: true, E2: true, E3: true, E4: true });
  });

  it('verifies a host in the three requests the default allows, the git-hook probe left for later', async () => {
    behave({ protectGit: true });
    const result = await check({ maxRequests: 3 });
    expect(marksOf(result)).toMatchObject({
      allow: 'passed:ran',
      'secret-egress': 'passed:blocked',
      'secret-egress:control': 'passed:armed',
      deny: 'not-attempted:max-requests',
    });
    expect(result.state).toBe('verified');
    expect(fake.calls()).toHaveLength(3);
  });

  it('judged the commands with the hook of the check: the audit log of the throwaway home has them', async () => {
    behave({ protectGit: true });
    await check({ maxRequests: 3 });
    const entries = await rig.audit();
    // The allow and the made-up key probe were judged; the control run has no hook to ask.
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.decision?.effect)).toEqual(['allow', 'deny']);
    expect(entries[1]?.decision?.ruleId).toBe('deny-secret-egress');
  });

  it('fails a host that runs a command the hook denied', async () => {
    behave({ ignoreDeny: true, protectGit: true });
    const result = await check();
    expect(result.state).toBe('failed');
    expect(marksOf(result)['secret-egress']).toBe('failed:executed-despite-deny');
  });

  it('stops a host that is paid for by an API key before the hook is asked or a command is run', async () => {
    behave({ apiKeySource: 'user', pauseAfterInitMs: 5_000 });
    const result = await check();
    expect(result.state).not.toBe('verified');
    expect(marksOf(result)['allow']).toBe('inconclusive:api-billing');
    // One request, and the host did not get to do what it was asked: no hook call, no file.
    expect(fake.calls()).toHaveLength(1);
    expect(await rig.audit()).toEqual([]);
    expect(existsSync(join(rig.project, ALLOW_FILE))).toBe(false);
    expect(isAlive(fake.calls()[0]?.pid ?? 0)).toBe(false);
    // And none of the other probes asked for another.
    for (const probe of result.probes.filter((p) => p.id !== 'allow'))
      expect(probe.mark).toBe('not-attempted');
  });
});
