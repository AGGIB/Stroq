import { describe, expect, it } from 'vitest';
import { compareMcpToolContract, getMcpToolContractFragment } from './mcp-tool-contract-comparison';

const baseline = { sha256: 'a'.repeat(64), approvedAt: '2026-10-24T01:00:00.000Z' };
const contract = (value: object) =>
  JSON.stringify({ name: 'notes:read', inputSchema: { type: 'object' }, ...value });

describe('exact advertised contract comparison', () => {
  it('keeps first review and missing legacy approval bodies distinct from unchanged', () => {
    const current = contract({ description: 'current' });
    expect(compareMcpToolContract(current, null, null).status).toBe('first-seen');
    expect(compareMcpToolContract(current, null, baseline).status).toBe('baseline-unavailable');
    expect(compareMcpToolContract(current, current, baseline)).toMatchObject({
      status: 'unchanged',
      counts: { added: 0, changed: 0, removed: 0 },
      changes: [],
    });
  });
  it('reports added, changed and removed fields deterministically without judging safety', () => {
    const before = contract({ description: 'before', annotations: { readOnlyHint: true } });
    const after = contract({ description: 'after', outputSchema: { type: 'object' } });
    expect(compareMcpToolContract(after, before, baseline)).toMatchObject({
      status: 'changed',
      counts: { added: 1, changed: 1, removed: 1 },
      changes: [
        { path: '/annotations', kind: 'removed' },
        { path: '/description', kind: 'changed' },
        { path: '/outputSchema', kind: 'added' },
      ],
    });
  });
  it('keeps array order, escaped pointer keys and literal null exact', () => {
    const before = contract({ _meta: { 'a/b~c': null, values: [1, 2] } });
    const after = contract({ _meta: { 'a/b~c': false, values: [2, 1] } });
    const comparison = compareMcpToolContract(after, before, baseline);
    expect(comparison.changes).toEqual([
      { path: '/_meta/a~1b~0c', kind: 'changed' },
      { path: '/_meta/values', kind: 'changed' },
    ]);
    expect(getMcpToolContractFragment(before, '/_meta/a~1b~0c')).toBe('null');
    expect(getMcpToolContractFragment(after, '/_meta/absent')).toBeUndefined();
    expect(getMcpToolContractFragment(after, '/_meta/values')).toBe('[2,1]');
    expect(getMcpToolContractFragment(after, '/_meta/a~2b')).toBeUndefined();
  });
  it('does not treat object key order as a change', () => {
    expect(
      compareMcpToolContract(
        contract({ _meta: { a: 1, b: 2 } }),
        contract({ _meta: { b: 2, a: 1 } }),
        baseline,
      ).status,
    ).toBe('unchanged');
  });
  it('withholds partial counts and rows when comparison bounds are exceeded', () => {
    const a = Object.fromEntries(Array.from({ length: 257 }, (_, i) => ['field-' + i, 0]));
    const b = Object.fromEntries(Array.from({ length: 257 }, (_, i) => ['field-' + i, 1]));
    expect(
      compareMcpToolContract(contract({ _meta: b }), contract({ _meta: a }), baseline),
    ).toMatchObject({ status: 'incomplete', counts: null, changes: [] });
    const key = 'x'.repeat(33_000);
    expect(
      compareMcpToolContract(
        contract({ _meta: { [key]: { a: 1, b: 1 } } }),
        contract({ _meta: { [key]: { a: 0, b: 0 } } }),
        baseline,
      ).status,
    ).toBe('incomplete');
  });
  it('rejects malformed fragments and prototype traversal without interpreting text', () => {
    expect(
      getMcpToolContractFragment(
        contract({ description: '<script>https://host.invalid</script>' }),
        '/description',
      ),
    ).toBe('"<script>https://host.invalid</script>"');
    expect(getMcpToolContractFragment('{}', '/constructor')).toBeUndefined();
    expect(getMcpToolContractFragment('{}', 'not-a-pointer')).toBeUndefined();
    expect(getMcpToolContractFragment('{', '')).toBeUndefined();
    expect(compareMcpToolContract('{', '{}', baseline).status).toBe('incomplete');
  });
});
