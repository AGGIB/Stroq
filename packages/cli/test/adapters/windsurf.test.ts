import type { Decision } from '@stroq/core';
import { describe, expect, it } from 'vitest';
import {
  WINDSURF_EVENTS,
  WINDSURF_TOO_MANY_TARGETS,
  WindsurfHookInputSchema,
  isWindsurfEvent,
  renderDecision,
  windsurfBlockOutput,
  windsurfFailClosedOutput,
  windsurfUnreadableInput,
} from '../../src/adapters/windsurf.js';

const parsed = (fields: Record<string, unknown>) =>
  WindsurfHookInputSchema.parse({
    agent_action_name: 'pre_run_command',
    trajectory_id: 'windsurf-1',
    execution_id: 'turn-1',
    timestamp: '2026-09-06T10:00:00.000Z',
    model_name: 'claude-sonnet',
    ...fields,
  });

const deny: Decision = {
  effect: 'deny',
  ruleId: 'deny-self-tamper',
  reason: 'Modifying agent security configuration is blocked',
};
const ask: Decision = {
  effect: 'ask',
  reason: 'This command is destructive',
  ruleId: 'ask-destructive',
};
const allow: Decision = { effect: 'allow', ruleId: 'allow-default', reason: 'no rule matched' };

describe('the payload, which names its own event', () => {
  it('needs a session and an event name, and nothing else', () => {
    // `trajectory_id` is the conversation, i.e. the Stroq session: an event without
    // one cannot be tainted or untainted, and malformed input is fail-closed.
    expect(() => parsed({ trajectory_id: '' })).toThrow();
    expect(() => parsed({ trajectory_id: undefined })).toThrow();
    expect(() => parsed({ agent_action_name: undefined })).toThrow();
    expect(() => parsed({ agent_action_name: 7 })).toThrow();
    expect(
      WindsurfHookInputSchema.parse({ agent_action_name: 'pre_read_code', trajectory_id: 't' })
        .tool_info,
    ).toBeUndefined();
  });

  it('never rejects an event over a field it does not read', () => {
    // A shape surprise in a field Stroq ignores must not discard the whole event: a
    // discarded `post` is a scan that never runs and a taint that is never set.
    const input = parsed({
      execution_id: { v: 1 },
      timestamp: 12345,
      model_name: null,
      some_future_field: 'kept',
    });
    expect(input.trajectory_id).toBe('windsurf-1');
    expect(input['some_future_field']).toBe('kept');
  });

  it('recognises the six events it installs on and nothing else', () => {
    expect(WINDSURF_EVENTS).toHaveLength(6);
    expect(isWindsurfEvent('pre_run_command')).toBe(true);
    expect(isWindsurfEvent('post_run_command')).toBe(false);
  });
});

describe('rendering, which is exit codes and stderr because there is no stdout contract', () => {
  it('says nothing at all on an allow', () => {
    expect(renderDecision(allow, [], [])).toEqual({ stdout: '', exitCode: 0 });
  });

  it('blocks with exit 2 and the reason on stderr', () => {
    const out = renderDecision(deny, [], []);
    expect(out).toEqual({
      stdout: '',
      stderr:
        'Stroq blocked this action (deny-self-tamper): Modifying agent security configuration is blocked',
      exitCode: 2,
    });
  });

  it('turns an ask into a block that says a prompt was not possible', () => {
    // Windsurf's hook contract has no `ask`. Rather than drop the decision to an
    // allow, the adapter denies and says so, naming the rule to relax — lossy on the
    // wire by design, never lossy in the audit.
    const out = renderDecision(ask, [], []);
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe(
      'Stroq would ask before this action (ask-destructive): This command is destructive. ' +
        'Windsurf hooks cannot prompt, so it is denied; run it yourself or relax the rule in ~/.stroq/policy.yaml.',
    );
  });

  it('appends evidence sentences to a block', () => {
    const now = new Date('2026-09-06T12:00:00.000Z');
    const out = renderDecision(
      deny,
      [
        {
          atom: { kind: 'pkg', value: 'awesome-widgets' },
          record: {
            seq: 1,
            at: '2026-09-06T11:00:00.000Z',
            tool: 'Read',
            source: 'README.md',
            kind: 'pkg',
            hash: 'abc',
            excerpt: 'awesome-widgets',
            suspect: true,
          },
        },
      ],
      [],
      now,
    );
    expect(out.stderr).toContain('Stroq blocked this action (deny-self-tamper)');
    expect(out.stderr).toContain('Evidence:');
  });

  it('is the same shape for an internal block', () => {
    expect(windsurfBlockOutput('anything')).toEqual({
      stdout: '',
      stderr: 'anything',
      exitCode: 2,
    });
  });
});

describe('the two adapter-level denies', () => {
  it('names the keys it saw and never a value', () => {
    const decision = windsurfUnreadableInput('body, headers');
    expect(decision.effect).toBe('deny');
    expect(decision.ruleId).toBe('windsurf-unreadable-input');
    expect(decision.reason).toContain('body, headers');
    expect(decision.reason).toContain('denied fail-closed');
    expect(decision.reason).toContain('https://github.com/AGGIB/Stroq/issues');
  });

  it('bounds the fan-out even though no Windsurf payload can reach the bound today', () => {
    // `decideWithGuards` requires a decision for the case, and the bound is what
    // stops a future candidate list from being unbounded. Windsurf's own lists
    // cannot trip it: a path fans out over at most three field spellings and a
    // command over at most six.
    expect(WINDSURF_TOO_MANY_TARGETS.effect).toBe('deny');
    expect(WINDSURF_TOO_MANY_TARGETS.ruleId).toBe('windsurf-too-many-targets');
    expect(WINDSURF_TOO_MANY_TARGETS.reason).toContain('64');
  });
});

describe('windsurfFailClosedOutput', () => {
  it('blocks with exit 2 on the three pre events where a deny stops something', () => {
    for (const event of ['pre_run_command', 'pre_write_code', 'pre_mcp_tool_use'])
      expect(
        windsurfFailClosedOutput({ agent_action_name: event }, new Error('boom')),
        event,
      ).toEqual({
        stdout: '',
        stderr: 'Stroq internal error (fail-closed): boom',
        exitCode: 2,
      });
  });

  it('blocks when the event is too malformed to tell what it was', () => {
    // A missing or non-string `agent_action_name` is malformed input, which is
    // fail-closed exactly like stdin that was not JSON at all.
    for (const raw of [{}, 'not an object', { agent_action_name: 7 }, null])
      expect(windsurfFailClosedOutput(raw, 'boom')).toMatchObject({ exitCode: 2, stdout: '' });
  });

  it('stays silent where there is nothing left to block', () => {
    for (const event of [
      'pre_read_code',
      'post_read_code',
      'post_mcp_tool_use',
      'post_run_command',
      'pre_user_prompt',
      'something_new',
    ])
      expect(
        windsurfFailClosedOutput({ agent_action_name: event }, new Error('boom')),
        event,
      ).toEqual({ stdout: '', exitCode: 0 });
  });
});
