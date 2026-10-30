import { describe, expect, it } from 'vitest';
import { parsePolicy } from '../../src/policy/load-policy.js';
import { PolicySchema } from '../../src/policy/policy-types.js';
import { evaluatePolicy } from '../../src/policy/evaluate.js';
import type { McpIdentityChannel } from '../../src/mcp/identity.js';

const base = { version: 2, rules: [], mcpGovernance: { allowed: [] } };
const entry = { channel: 'claude-code', name: 'Docs_Server' };
const policy = (allowed = [entry]) => PolicySchema.parse({ ...base, mcpGovernance: { allowed } });
const witness = (name = entry.name, channel: McpIdentityChannel = 'claude-code') => ({
  mcpIdentity: { kind: 'server' as const, channel, name },
});

describe('versioned MCP governance policy', () => {
  it('keeps v1 defaults and refuses governance in a v1 file', () => {
    expect(PolicySchema.parse({ version: 1, rules: [] })).toEqual({
      version: 1,
      rules: [],
      threshold: 0.6,
      default: 'allow',
    });
    expect(PolicySchema.safeParse({ ...base, version: 1 }).success).toBe(false);
    expect(() => parsePolicy('version: 1\nrules: []\nmcpGovernance: {allowed: []}\n')).toThrow();
  });

  it('requires the complete v2 control and permits an empty deny-all list', () => {
    expect(PolicySchema.safeParse({ version: 2, rules: [] }).success).toBe(false);
    expect(policy([]).mcpGovernance).toEqual({ allowed: [] });
    expect(PolicySchema.safeParse({ ...base, version: 3 }).success).toBe(false);
  });

  it.each([
    { ...base, observe: true },
    { ...base, mcpGovernance: { allowed: [], mode: 'observe' } },
    { ...base, mcpGovernance: { allowed: [{ ...entry, tool: '*' }] } },
    { ...base, mcpGovernance: { allowed: [{ ...entry, channel: 'copilot' }] } },
    { ...base, mcpGovernance: { allowed: [entry, entry] } },
    {
      ...base,
      mcpGovernance: {
        allowed: Array.from({ length: 65 }, (_, i) => ({ ...entry, name: `s${i}` })),
      },
    },
    {
      ...base,
      rules: [
        { id: 'r', effect: 'allow', reason: 'x', extra: true, when: { classes: ['mcp.call'] } },
      ],
    },
    {
      ...base,
      rules: [
        { id: 'r', effect: 'allow', reason: 'x', when: { classes: ['mcp.call'], server: 'x' } },
      ],
    },
  ])('refuses unknown fields, duplicate entries and unsupported controls', (value) => {
    expect(PolicySchema.safeParse(value).success).toBe(false);
  });

  it.each(['', ' x', 'x ', '*', '../x', 'x/y', 'x\n', '\u202ex', 'x'.repeat(129)])(
    'refuses a non-lexical or oversized allowlist name %j',
    (name) => {
      expect(
        PolicySchema.safeParse({ ...base, mcpGovernance: { allowed: [{ ...entry, name }] } })
          .success,
      ).toBe(false);
    },
  );
});

describe('MCP governance is a deny-only prerequisite', () => {
  it('allows the listed exact channel/name to continue through the ordinary evaluator', () => {
    expect(evaluatePolicy(policy(), ['mcp.call'], null, witness()).effect).toBe('allow');
    expect(evaluatePolicy(policy(), ['mcp.call'], null, witness('docs_server')).ruleId).toBe(
      'mcp-governance-unlisted',
    );
    expect(evaluatePolicy(policy(), ['mcp.call'], null, witness(entry.name, 'cursor')).ruleId).toBe(
      'mcp-governance-unlisted',
    );
    expect(evaluatePolicy(policy([]), ['mcp.call'], null, witness()).ruleId).toBe(
      'mcp-governance-unlisted',
    );
  });

  it.each([
    undefined,
    {},
    { mcpIdentity: undefined },
    { mcpIdentity: { kind: 'unavailable', channel: 'claude-code', reason: 'ambiguous' } },
    { mcpIdentity: { kind: 'server', channel: 'claude-code', name: entry.name, extra: true } },
    { mcpIdentity: { kind: 'server', channel: 'forged', name: entry.name } },
  ])('refuses absent or malformed identity without interpolating server data', (event) => {
    const decision = evaluatePolicy(policy(), ['mcp.call'], null, event as never);
    expect(decision).toMatchObject({ effect: 'deny', ruleId: 'mcp-governance-identity-unknown' });
    expect(decision.reason).not.toContain(entry.name);
  });

  it('recognizes a present witness as MCP even when the classifier had no MCP class', () => {
    expect(evaluatePolicy(policy([]), [], null, witness()).effect).toBe('deny');
    expect(evaluatePolicy(policy([]), [], null, { mcpIdentity: null } as never).effect).toBe(
      'deny',
    );
    expect(evaluatePolicy(policy([]), [], null).effect).toBe('allow');
  });

  it('does not replace taint, secret, default or explicit deny/ask decisions', () => {
    for (const effect of ['deny', 'ask'] as const) {
      const guarded = PolicySchema.parse({
        ...policy(),
        rules: [
          {
            id: 'existing-secret',
            effect,
            reason: 'existing decision',
            when: { classes: ['secret.egress'], taint: 'any' },
          },
        ],
      });
      expect(evaluatePolicy(guarded, ['mcp.call', 'secret.egress'], null, witness())).toEqual({
        effect,
        ruleId: 'existing-secret',
        reason: 'existing decision',
      });
      expect(
        evaluatePolicy({ ...policy(), default: effect }, ['mcp.call'], null, witness()).effect,
      ).toBe(effect);
    }
    const tainted = PolicySchema.parse({
      ...policy(),
      rules: [
        {
          id: 'tainted',
          effect: 'deny',
          reason: 'taint decision',
          when: { classes: ['mcp.call'], taint: 'suspect' },
        },
      ],
    });
    expect(evaluatePolicy(tainted, ['mcp.call'], 'suspect', witness()).ruleId).toBe('tainted');
  });

  it('does not change legacy v1 calls without a governance control', () => {
    const legacy = PolicySchema.parse({ version: 1, rules: [] });
    expect(evaluatePolicy(legacy, ['mcp.call'], null).effect).toBe('allow');
  });
});
