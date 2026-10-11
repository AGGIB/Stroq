import type { EvidenceInput } from '../../src/live/evidence.js';
import type { ProbeKind, SentinelState, StreamEvent } from '../../src/live/types.js';
import { NONCE, auditFor, expectationOf, finished, toolUse } from './helpers.js';
import { probe } from './probe-helpers.js';

export const THERE: SentinelState = { exists: true, content: `${NONCE}\n` };
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
