import { describe, expect, it } from 'vitest';
import { withWayOut } from '../../src/policy/way-out.js';
import type { Policy, Rule } from '../../src/policy/policy-types.js';
import type { Decision, Taint } from '../../src/types.js';

const mockRule = (overrides: Partial<Rule>): Rule => ({
  id: 'deny-suspect',
  effect: 'deny',
  reason: 'Denied by suspect rule.',
  when: {
    classes: [],
    ...overrides.when,
  },
  ...overrides,
});

const mockPolicy = (rules: Rule[]): Policy => ({
  version: 1,
  default: 'allow',
  threshold: 0.7,
  rules,
});

describe('withWayOut', () => {
  const now = new Date('2026-10-15T12:00:00Z');

  it('returns the original decision if effect is allow', () => {
    const decision: Decision = { effect: 'allow', ruleId: 'rule-1', reason: 'Allowed.' };
    const policy = mockPolicy([mockRule({ id: 'rule-1', when: { classes: ['origin.suspect'] } })]);
    expect(withWayOut(decision, policy, null, 'sess-1', now)).toBe(decision);
  });

  it('returns the original decision if ruleId is null', () => {
    const decision: Decision = { effect: 'deny', ruleId: null, reason: 'Default deny.' };
    const policy = mockPolicy([]);
    expect(withWayOut(decision, policy, null, 'sess-1', now)).toBe(decision);
  });

  it('returns the original decision if rule is not found in policy', () => {
    const decision: Decision = { effect: 'deny', ruleId: 'unknown-rule', reason: 'Denied.' };
    const policy = mockPolicy([]);
    expect(withWayOut(decision, policy, null, 'sess-1', now)).toBe(decision);
  });

  it('returns the original decision if rule does not match taint or origin.suspect', () => {
    const rule = mockRule({
      id: 'rule-ordinary',
      when: { classes: ['network.egress'], taint: 'clean' },
    });
    const decision: Decision = { effect: 'deny', ruleId: 'rule-ordinary', reason: 'No network.' };
    const policy = mockPolicy([rule]);
    expect(withWayOut(decision, policy, null, 'sess-1', now)).toBe(decision);
  });

  it('adds untaint instructions when rule triggers on origin.suspect without taint details', () => {
    const rule = mockRule({
      id: 'rule-origin',
      when: { classes: ['origin.suspect'] },
    });
    const decision: Decision = {
      effect: 'deny',
      ruleId: 'rule-origin',
      reason: 'Denied on suspect origin.',
    };
    const policy = mockPolicy([rule]);

    const result = withWayOut(decision, policy, null, 'sess-123', now);
    expect(result.reason).toContain('Denied on suspect origin.');
    expect(result.reason).toContain(
      'If that was a false positive, clear it yourself, outside the agent: stroq untaint --session sess-123',
    );
    expect(result.reason).not.toContain('Tainted by');
  });

  it('includes taint details, age, and untaint instruction when taint is suspect', () => {
    const rule = mockRule({
      id: 'rule-suspect',
      when: { classes: [], taint: 'suspect' },
    });
    const decision: Decision = {
      effect: 'ask',
      ruleId: 'rule-suspect',
      reason: 'Confirm suspect action',
    };
    const policy = mockPolicy([rule]);

    const taint: Taint = {
      status: 'suspect',
      sources: [
        {
          tool: 'Bash',
          source: 'curl https://evil.example',
          at: new Date('2026-10-15T11:59:50Z'), // 10s ago
        },
      ],
    };

    const result = withWayOut(decision, policy, taint, 'session-abc', now);
    expect(result.effect).toBe('ask');
    expect(result.reason).toContain(
      'Confirm suspect action. Tainted by Bash curl https://evil.example 10 s ago.',
    );
    expect(result.reason).toContain('stroq untaint --session session-abc');
    expect(result.reason).not.toContain('stroq trust');
  });

  it('suggests stroq trust when source tool is Read with a file path', () => {
    const rule = mockRule({
      id: 'rule-suspect',
      when: { classes: [], taint: 'suspect' },
    });
    const decision: Decision = { effect: 'deny', ruleId: 'rule-suspect', reason: 'Blocked.' };
    const policy = mockPolicy([rule]);

    const taint: Taint = {
      status: 'suspect',
      sources: [
        {
          tool: 'Read',
          source: 'docs/architecture.md',
          at: new Date('2026-10-15T11:58:00Z'), // 2 min ago
        },
      ],
    };

    const result = withWayOut(decision, policy, taint, 'sess-1', now);
    expect(result.reason).toContain('Tainted by Read docs/architecture.md 2 min ago.');
    expect(result.reason).toContain('stroq untaint --session sess-1');
    expect(result.reason).toContain(
      '; to stop that file tainting it again: stroq trust docs/architecture.md',
    );
  });

  it('quotes paths with spaces and single quotes safely for the shell', () => {
    const rule = mockRule({
      id: 'rule-suspect',
      when: { classes: [], taint: 'suspect' },
    });
    const decision: Decision = { effect: 'deny', ruleId: 'rule-suspect', reason: 'Blocked' };
    const policy = mockPolicy([rule]);

    const taint: Taint = {
      status: 'suspect',
      sources: [
        {
          tool: 'Read',
          source: "path with spaces/it's dangerous.md",
          at: new Date('2026-10-15T11:59:00Z'),
        },
      ],
    };

    const result = withWayOut(decision, policy, taint, 'session with spaces', now);
    expect(result.reason).toContain(
      "stroq untaint --session 'session with spaces'; to stop that file tainting it again: stroq trust 'path with spaces/it'\\''s dangerous.md'",
    );
  });

  it('neutralizes control sequences in tainted paths', () => {
    const rule = mockRule({
      id: 'rule-suspect',
      when: { classes: [], taint: 'suspect' },
    });
    const decision: Decision = { effect: 'deny', ruleId: 'rule-suspect', reason: 'Blocked.' };
    const policy = mockPolicy([rule]);

    const taint: Taint = {
      status: 'suspect',
      sources: [
        {
          tool: 'Read',
          source: 'docs/\u001b[31mpayload\u0007.txt',
          at: new Date('2026-10-15T11:59:55Z'),
        },
      ],
    };

    const result = withWayOut(decision, policy, taint, 's1', now);
    expect(result.reason).not.toContain('\u001b');
    expect(result.reason).not.toContain('\u0007');
    expect(result.reason).toContain('docs/\\u001b[31mpayload\\u0007.txt');
  });
});
