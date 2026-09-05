import { describe, expect, it } from 'vitest';
import {
  CURSOR_BLOCKING_EVENTS,
  CURSOR_EVENTS,
  cursorFailClosedOutput,
  renderDecision,
} from '../../src/adapters/cursor.js';

const body = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>;

describe('renderDecision', () => {
  const secrets = [{ name: 'DB_PASSWORD', source: '.env', canary: false }];

  it('returns null for an allow', () => {
    expect(renderDecision({ effect: 'allow', ruleId: null, reason: 'ok' }, [], [])).toBeNull();
  });

  it('puts the evidence on the agent message only', () => {
    expect(
      renderDecision(
        {
          effect: 'deny',
          ruleId: 'deny-secret-egress',
          reason: 'a known secret value is in the arguments',
        },
        [],
        secrets,
      ),
    ).toEqual({
      permission: 'deny',
      user_message:
        'Stroq blocked this action (deny-secret-egress): a known secret value is in the arguments',
      agent_message:
        'Stroq blocked this action (deny-secret-egress): a known secret value is in the arguments Evidence: the arguments contain the value of DB_PASSWORD from .env.',
    });
  });

  it('renders an ask', () => {
    expect(
      renderDecision(
        { effect: 'ask', ruleId: 'ask-destructive', reason: 'destructive command' },
        [],
        [],
      ),
    ).toEqual({
      permission: 'ask',
      user_message: 'Stroq: destructive command (ask-destructive)',
      agent_message: 'Stroq: destructive command (ask-destructive)',
    });
  });
});

describe('cursorFailClosedOutput', () => {
  it('denies for the two blocking events', () => {
    expect(CURSOR_BLOCKING_EVENTS).toEqual(['beforeShellExecution', 'beforeMCPExecution']);
    for (const name of CURSOR_BLOCKING_EVENTS) {
      const out = cursorFailClosedOutput({ hook_event_name: name }, new Error('boom'));
      expect(out.exitCode).toBe(0);
      expect(body(out.stdout)).toEqual({
        permission: 'deny',
        user_message: 'Stroq internal error (fail-closed): boom',
        agent_message: 'Stroq internal error (fail-closed): boom',
      });
    }
  });

  it('prints nothing where there is nothing to block', () => {
    const others = CURSOR_EVENTS.filter((e) => !CURSOR_BLOCKING_EVENTS.includes(e));
    expect(others).toEqual([
      'afterShellExecution',
      'afterMCPExecution',
      'beforeReadFile',
      'afterFileEdit',
    ]);
    for (const name of others)
      expect(cursorFailClosedOutput({ hook_event_name: name }, new Error('boom'))).toEqual({
        stdout: '',
        exitCode: 0,
      });
  });

  it('stays silent for a named event Stroq did not install on', () => {
    for (const name of ['beforeSubmitPrompt', 'afterTabFileEdit', 'stop'])
      expect(cursorFailClosedOutput({ hook_event_name: name }, new Error('boom'))).toEqual({
        stdout: '',
        exitCode: 0,
      });
  });

  it('denies when the event name is missing or not a string (M2)', () => {
    const deny = {
      permission: 'deny',
      user_message: 'Stroq internal error (fail-closed): boom',
      agent_message: 'Stroq internal error (fail-closed): boom',
    };
    for (const raw of [{}, { hook_event_name: 42 }, { hook_event_name: null }, 'not an object']) {
      const out = cursorFailClosedOutput(raw, new Error('boom'));
      expect(out.exitCode).toBe(0);
      expect(body(out.stdout)).toEqual(deny);
    }
  });
});
