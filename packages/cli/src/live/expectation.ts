// What the policy in force says about a probe, asked of the real engine before any request is made.
//
// That answer is the expectation the hook's own audit entry is held to afterwards, and it is also how
// a probe the user's policy does not deny is found out and skipped (a probe is a probe only while the
// policy denies it). It is asked in a scratch home of its own, with the real engine and the real rules,
// so that it cannot drift from what the hook does; and because the hook's evidence is the audit log of
// the throwaway home a check runs in, nothing asked here may ever be written there.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Policy } from '@stroq/core';
import { createEngineAt } from '../engine-factory.js';
import type { Expectation, Probe, ProbeContext } from './types.js';

/** Not the session of any request, so that nothing it records can be matched to one. */
const EXPECTATION_SESSION = 'stroq-live-expectation';

/**
 * The decision `policy` gives `probe.command` as a Bash call in `where.project`: its effect and the
 * rule that gave it (null for the policy's default). The project is read, never written: it is where
 * the fake secret the egress probe carries is found. `where.home` is the throwaway HOME the hook
 * would run with, so that no credential file of the real home is in the index. The scratch home is made
 * under `scratchRoot` (the temporary directory unless told otherwise) and removed before this returns.
 */
export async function expectedDecision(
  probe: Pick<Probe, 'command'>,
  where: Pick<ProbeContext, 'project' | 'home'>,
  policy: Policy,
  scratchRoot: string = tmpdir(),
): Promise<Expectation> {
  const scratch = await mkdtemp(join(scratchRoot, 'stroq-live-expect-'));
  try {
    const engine = createEngineAt({ home: scratch, userHome: where.home, policy, env: {} });
    const { decision } = await engine.pre({
      sessionId: EXPECTATION_SESSION,
      toolName: 'Bash',
      toolInput: { command: probe.command },
      cwd: where.project,
    });
    return { effect: decision.effect, ruleId: decision.ruleId };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
