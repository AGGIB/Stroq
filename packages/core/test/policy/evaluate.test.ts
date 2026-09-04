import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '../../src/policy/default-policy.js';
import { evaluatePolicy } from '../../src/policy/evaluate.js';
import { parsePolicy } from '../../src/policy/load-policy.js';

describe('evaluatePolicy with DEFAULT_POLICY', () => {
  it('allows when no classes match', () => {
    expect(evaluatePolicy(DEFAULT_POLICY, [], null)).toEqual({
      effect: 'allow',
      ruleId: null,
      reason: 'default',
    });
  });
  it('always denies encoded execution and self tampering', () => {
    expect(evaluatePolicy(DEFAULT_POLICY, ['shell.exec_encoded'], null).effect).toBe('deny');
    expect(evaluatePolicy(DEFAULT_POLICY, ['config.self'], null).ruleId).toBe('deny-self-tamper');
  });
  it('asks for commands that merely reference agent security config, tainted or not', () => {
    expect(evaluatePolicy(DEFAULT_POLICY, ['config.self_touch'], null)).toMatchObject({
      effect: 'ask',
      ruleId: 'ask-self-touch',
    });
    expect(evaluatePolicy(DEFAULT_POLICY, ['config.self_touch'], 'suspect')).toMatchObject({
      effect: 'ask',
      ruleId: 'ask-self-touch',
    });
  });
  it('allows network commands and secret reads while untainted, denies them when tainted', () => {
    expect(evaluatePolicy(DEFAULT_POLICY, ['shell.network'], null).effect).toBe('allow');
    expect(evaluatePolicy(DEFAULT_POLICY, ['fs.secrets'], null).effect).toBe('allow');
    expect(evaluatePolicy(DEFAULT_POLICY, ['shell.network'], 'suspect')).toMatchObject({
      effect: 'deny',
      ruleId: 'deny-network-when-tainted',
    });
    expect(evaluatePolicy(DEFAULT_POLICY, ['fs.secrets'], 'suspect').effect).toBe('deny');
    expect(evaluatePolicy(DEFAULT_POLICY, ['git.push_external'], 'suspect').effect).toBe('deny');
  });
  it('asks for destructive commands and external pushes regardless of taint', () => {
    expect(evaluatePolicy(DEFAULT_POLICY, ['shell.destructive'], null).effect).toBe('ask');
    expect(evaluatePolicy(DEFAULT_POLICY, ['git.push_external'], null).effect).toBe('ask');
  });
  it('asks for MCP side effects only when tainted', () => {
    expect(evaluatePolicy(DEFAULT_POLICY, ['mcp.call', 'mcp.side_effect'], null).effect).toBe(
      'allow',
    );
    expect(evaluatePolicy(DEFAULT_POLICY, ['mcp.call', 'mcp.side_effect'], 'suspect').effect).toBe(
      'ask',
    );
  });
  it('allows WebFetch while clean and denies it once the session is tainted', () => {
    expect(evaluatePolicy(DEFAULT_POLICY, ['network.fetch'], null).effect).toBe('allow');
    expect(evaluatePolicy(DEFAULT_POLICY, ['network.fetch'], 'suspect')).toMatchObject({
      effect: 'deny',
      ruleId: 'deny-fetch-when-tainted',
    });
  });
  it('first matching rule wins', () => {
    const d = evaluatePolicy(DEFAULT_POLICY, ['shell.destructive', 'shell.exec_encoded'], null);
    expect(d.effect).toBe('deny');
  });
  it('denies an action dictated by flagged content and asks for one copied from unflagged content', () => {
    expect(
      evaluatePolicy(DEFAULT_POLICY, ['origin.untrusted', 'origin.suspect'], null),
    ).toMatchObject({ effect: 'deny', ruleId: 'deny-origin-suspect' });
    expect(evaluatePolicy(DEFAULT_POLICY, ['origin.untrusted'], null)).toMatchObject({
      effect: 'ask',
      ruleId: 'ask-origin-untrusted',
    });
    // Existing deny rules keep precedence over the origin "ask".
    expect(
      evaluatePolicy(DEFAULT_POLICY, ['shell.network', 'origin.untrusted'], 'suspect'),
    ).toMatchObject({ effect: 'deny', ruleId: 'deny-network-when-tainted' });
    // Encoded execution keeps its own rule id even when provenance also fires.
    expect(
      evaluatePolicy(
        DEFAULT_POLICY,
        ['shell.exec_encoded', 'origin.untrusted', 'origin.suspect'],
        null,
      ).ruleId,
    ).toBe('deny-encoded-exec');
  });
});

describe('F4 ask-self-touch must not shadow deny rules', () => {
  it('denies encoded exec even when self_touch is also present, clean session', () => {
    const d = evaluatePolicy(DEFAULT_POLICY, ['shell.exec_encoded', 'config.self_touch'], null);
    expect(d).toMatchObject({ effect: 'deny', ruleId: 'deny-encoded-exec' });
  });
  it('denies tainted network/secrets even when self_touch is also present', () => {
    const d = evaluatePolicy(
      DEFAULT_POLICY,
      ['shell.network', 'fs.secrets', 'config.self_touch'],
      'suspect',
    );
    expect(d.effect).toBe('deny');
  });
  it('still asks for self_touch alone, clean session', () => {
    const d = evaluatePolicy(DEFAULT_POLICY, ['config.self_touch'], null);
    expect(d).toMatchObject({ effect: 'ask', ruleId: 'ask-self-touch' });
  });
});

describe('parsePolicy', () => {
  it('applies defaults and validates effects', () => {
    const p = parsePolicy(
      'version: 1\nrules:\n  - id: x\n    effect: deny\n    reason: r\n    when:\n      classes: [shell.network]\n',
    );
    expect(p.threshold).toBe(0.6);
    expect(p.default).toBe('allow');
    expect(p.rules[0]?.when.taint).toBe('any');
  });
  it('rejects unknown effects and unknown classes', () => {
    expect(() =>
      parsePolicy(
        'version: 1\nrules:\n  - id: x\n    effect: maybe\n    reason: r\n    when:\n      classes: [shell.network]\n',
      ),
    ).toThrow();
    expect(() =>
      parsePolicy(
        'version: 1\nrules:\n  - id: x\n    effect: deny\n    reason: r\n    when:\n      classes: [nope]\n',
      ),
    ).toThrow();
  });
});
