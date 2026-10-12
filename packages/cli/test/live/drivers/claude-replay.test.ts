import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hookCommand } from '../../../src/commands/hook-command.js';
import { openLedger } from '../../../src/live/budget.js';
import { createClaudeDriver } from '../../../src/live/drivers/claude.js';
import type { HostResult } from '../../../src/live/types.js';
import { verifyHost } from '../../../src/live/verify.js';
import { CLI_ENTRY } from '../../helpers/cli-entry.js';
import { makeRig, type Rig } from '../rig.js';
import { marksOf, verifyOptions } from '../verify-harness.js';
import {
  canMakeFakeClaude,
  makeFakeClaude,
  makeFakeTools,
  type FakeClaude,
  type FakeTools,
} from './fake-claude.js';
import { STREAMS, replayOf } from './fixtures.js';

/**
 * `verifyHost` through the Claude driver, against a stand-in that plays back the REAL streams of Claude Code
 * 2.1.271 (`test/fixtures/hosts/claude-code`) while the real hook, built from this tree, judges the call in
 * them. What the host printed is what the host printed; the audit log and the files are the ones this request
 * made. It is the shape of a real run, in the order a real run has: the allow, the deny, the deny control.
 */
let rig: Rig;
let fake: FakeClaude;
let tools: FakeTools;
beforeEach(() => {
  rig = makeRig(false);
  fake = makeFakeClaude();
  tools = canMakeFakeClaude() ? makeFakeTools() : { dir: '', cleanup: () => undefined };
  mkdirSync(join(rig.root, 'host-home'));
});
afterEach(() => {
  fake.cleanup();
  rig.cleanup();
  tools.cleanup();
});

const check = (options: { readonly maxRequests?: number } = {}): Promise<HostResult> =>
  verifyHost(
    createClaudeDriver({
      hookLine: hookCommand(process.execPath, CLI_ENTRY, 'claude-code'),
      bin: fake.bin,
      killGraceMs: 500,
    }),
    rig.ctx({
      env: {
        PATH: `${tools.dir}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
        HOME: join(rig.root, 'host-home'),
      },
      deadlineMs: 60_000,
    }),
    verifyOptions({ ledger: openLedger({ memory: true, limit: 30 }), graceMs: 5_000, ...options }),
  );

describe.skipIf(!canMakeFakeClaude())(
  'the real streams of Claude Code 2.1.271, played back',
  () => {
    it('verifies the host in three requests: the allow, the deny stopped by the hook, and its armed control', async () => {
      fake.script([
        replayOf(STREAMS.allowRan),
        replayOf(STREAMS.denyBlocked),
        replayOf(STREAMS.denyControl),
      ]);
      const result = await check({ maxRequests: 3 });
      expect(marksOf(result)).toEqual({
        allow: 'passed:ran',
        deny: 'passed:blocked',
        'deny:control': 'passed:armed',
        'secret-egress': 'not-attempted:max-requests',
      });
      expect(result.state).toBe('verified');
      expect(result.hostVersion).toBe('2.1.271');
      expect(fake.calls()).toHaveLength(3);
      // The hook that judged the deny is the real one: its words are what the played-back stream says.
      expect(result.probes.find((p) => p.id === 'deny')?.evidence).toEqual({
        E1: true,
        E2: true,
        E3: true,
        E4: true,
      });
      expect((await rig.audit()).map((entry) => entry.decision?.ruleId ?? null)).toEqual([
        null,
        'deny-git-exec',
      ]);
    });

    it('is verified all the same when the model declines the secret-egress probe: it ends not issued', async () => {
      fake.script([
        replayOf(STREAMS.allowRan),
        replayOf(STREAMS.denyBlocked),
        replayOf(STREAMS.denyControl),
        replayOf(STREAMS.egressRefused),
      ]);
      const result = await check({ maxRequests: 4 });
      expect(marksOf(result)).toMatchObject({ 'secret-egress': 'not-issued:not-issued' });
      expect(result.state).toBe('verified');
      expect(fake.calls()).toHaveLength(4);
    });

    it("is not verified when the host's own step stopped the control: nothing is shown either way", async () => {
      fake.script([
        replayOf(STREAMS.allowRan),
        replayOf(STREAMS.denyBlocked),
        replayOf(STREAMS.denyControlUnarmed),
      ]);
      const result = await check({ maxRequests: 3 });
      expect(marksOf(result)).toMatchObject({
        allow: 'passed:ran',
        deny: 'inconclusive:probe-not-armed',
        'deny:control': 'inconclusive:probe-not-armed',
      });
      expect(result.state).toBe('inconclusive');
    });

    it('stops after the first request when the host does not say who is paid (2.1.144)', async () => {
      fake.script([replayOf(STREAMS.noProvider)]);
      const result = await check();
      expect(marksOf(result)['allow']).toBe('inconclusive:billing-unknown');
      expect(fake.calls()).toHaveLength(1);
      expect(result.state).toBe('inconclusive');
      for (const probe of result.probes.filter((p) => p.id !== 'allow'))
        expect(probe.mark).toBe('not-attempted');
    });
  },
);
