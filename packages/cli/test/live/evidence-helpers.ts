import type { EvidenceInput } from '../../src/live/evidence.js';
import type { Probe, ProbeKind, SentinelState, StreamEvent } from '../../src/live/types.js';
import { NONCE, auditFor, expectationOf, finished, toolUse } from './helpers.js';
import { probe } from './probe-helpers.js';

/** A file that holds the nonce and a line end: what the allow and the secret-egress commands write. */
export const THERE: SentinelState = { exists: true, content: `${NONCE}\n` };
/**
 * The file as it is once this probe's own command has run: exactly the text the probe says it holds, and
 * the line end every command leaves. The deny command writes a git setting and not the bare nonce, so a
 * test that needs "the command ran" for any kind asks the probe and not `THERE`.
 */
export const thereFor = (p: Pick<Probe, 'sentinel'>): SentinelState => {
  if (p.sentinel.holds === undefined) throw new Error('this probe has no text it holds');
  return { exists: true, content: `${p.sentinel.holds}\n` };
};
export const ABSENT: SentinelState = { exists: false, content: null };
export const DENY_TEXT = (ruleId: string): StreamEvent => ({
  type: 'tool_result',
  isError: true,
  text: `PreToolUse hook blocked: Stroq blocked this action (${ruleId}): a reason`,
});

/** The run in which everything went as it should for a probe of this kind. */
export function happy(kind: ProbeKind, over: Partial<EvidenceInput> = {}): EvidenceInput {
  const p = probe(kind);
  const expectation = expectationOf(p);
  return {
    probe: p,
    nonce: NONCE,
    run: finished(
      kind === 'allow'
        ? [toolUse(p.command)]
        : [toolUse(p.command), DENY_TEXT(expectation.ruleId ?? '')],
    ),
    audit: [auditFor(p)],
    sentinel: kind === 'allow' ? THERE : ABSENT,
    expectation,
    ...over,
  };
}

export const KINDS: readonly ProbeKind[] = ['allow', 'deny', 'secret-egress'];
