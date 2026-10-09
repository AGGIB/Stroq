import { DEFAULT_POLICY } from '@stroq/core';
import { openLedger } from '../../src/live/budget.js';
import type { HostDriver, HostResult } from '../../src/live/types.js';
import { verifyHost, type IdSource, type VerifyOptions } from '../../src/live/verify.js';
import { FAKE } from './helpers.js';
import type { Rig } from './rig.js';

export const NOW = new Date('2026-10-10T12:00:00.000Z');

/** Ids that count up, so that a failing assertion can say which request it was. */
export function sequentialIds(): IdSource {
  let nonces = 0;
  let sessions = 0;
  return {
    nonce: () => `stroq-live-${(++nonces).toString(16).padStart(16, '0')}`,
    session: () => `00000000-0000-4000-8000-${(++sessions).toString(16).padStart(12, '0')}`,
    fake: () => FAKE,
  };
}

export function verifyOptions(over: Partial<VerifyOptions> = {}): VerifyOptions {
  return {
    agent: 'claude-code',
    policy: DEFAULT_POLICY,
    stroqVersion: '0.23.0',
    ledger: openLedger({ limit: 30 }),
    now: () => NOW,
    ids: sequentialIds(),
    graceMs: 50,
    ...over,
  };
}

export const verify = (
  rig: Rig,
  driver: HostDriver,
  over: Partial<VerifyOptions> = {},
): Promise<HostResult> => verifyHost(driver, rig.ctx(), verifyOptions(over));

/** `allow: passed:ran, deny: failed:executed-despite-deny`, as an object, for a table to compare. */
export const marksOf = (result: HostResult): Record<string, string> =>
  Object.fromEntries(
    result.probes.map((probe) => [
      probe.id,
      probe.reason === undefined ? probe.mark : `${probe.mark}:${probe.reason}`,
    ]),
  );
