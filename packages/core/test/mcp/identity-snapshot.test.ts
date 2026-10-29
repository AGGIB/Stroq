import { describe, expect, it } from 'vitest';
import { snapshotMcpIdentity } from '../../src/mcp/identity.js';
import { evaluateMcpGovernance } from '../../src/policy/mcp-governance.js';
import { DEFAULT_POLICY } from '../../src/policy/default-policy.js';
import { PolicySchema } from '../../src/policy/policy-types.js';

const policy = PolicySchema.parse({
  ...DEFAULT_POLICY,
  version: 2,
  mcpGovernance: {
    allowed: [{ channel: 'codex', name: 'listed' }],
  },
});

describe('canonical producer identity snapshot at the authorization boundary', () => {
  const cases: {
    data: Record<string, string>;
    virtual: Record<string, string>;
    ruleId: string | null;
  }[] = [
    {
      data: { kind: 'server', channel: 'codex', name: 'unlisted' },
      virtual: { kind: 'server', name: 'listed' },
      ruleId: 'mcp-governance-unlisted',
    },
    {
      data: { kind: 'server', channel: 'codex', name: 'listed' },
      virtual: { kind: 'server', name: 'unlisted' },
      ruleId: null,
    },
    {
      data: { kind: 'unavailable', channel: 'codex', reason: 'missing' },
      virtual: { kind: 'server', name: 'listed' },
      ruleId: 'mcp-governance-identity-unknown',
    },
  ];
  it.each(cases)(
    'uses the data snapshot when normal property reads disagree: $ruleId',
    ({ data, virtual, ruleId }) => {
      let reads = 0;
      const identity = new Proxy(data, {
        get(target, key) {
          reads++;
          return Object.hasOwn(virtual, key) ? Reflect.get(virtual, key) : Reflect.get(target, key);
        },
      });
      const decision = evaluateMcpGovernance(policy, ['mcp.call'], {
        mcpIdentity: identity,
      } as never);
      expect(decision?.ruleId ?? null).toBe(ruleId);
      expect(reads).toBe(0);
    },
  );

  it('rejects an accessor without executing it and returns only a finite unknown refusal', () => {
    let reads = 0;
    const identity = {
      kind: 'server',
      channel: 'codex',
      get name() {
        reads++;
        return 'listed';
      },
    };
    expect(snapshotMcpIdentity(identity)).toBeNull();
    expect(
      evaluateMcpGovernance(policy, ['mcp.call'], { mcpIdentity: identity } as never)?.ruleId,
    ).toBe('mcp-governance-identity-unknown');
    expect(reads).toBe(0);
  });

  it('captures each own descriptor once and does not retain the mutable original', () => {
    const counts = new Map<PropertyKey, number>();
    const original = { kind: 'server', channel: 'codex', name: 'listed' };
    const identity = new Proxy(original, {
      getOwnPropertyDescriptor(target, key) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const captured = snapshotMcpIdentity(identity);
    expect([...counts.values()]).toEqual([1, 1, 1]);
    expect(captured).toEqual(original);
    expect(captured === identity).toBe(false);
    expect(Object.isFrozen(captured)).toBe(true);
    original.name = 'unlisted';
    expect(captured).toEqual({ kind: 'server', channel: 'codex', name: 'listed' });
    expect(snapshotMcpIdentity(identity)).toEqual({
      kind: 'server',
      channel: 'codex',
      name: 'unlisted',
    });
  });
});
