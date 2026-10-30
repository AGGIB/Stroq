import { describe, expect, it } from 'vitest';
import {
  policyHistorySelection,
  policyHistoryHref,
  policyHistoryReadAllowed,
} from './policy-history-navigation';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ws = `workspace-${'a'.repeat(24)}`;
describe('shared policy history selection', () => {
  it('selects only one exact intent record, without implying workspace ownership', () => {
    const href = policyHistoryHref(id);
    expect(href).toBe(`/policies/history/?entry=${id}`);
    const selected = policyHistorySelection(new URL(href, 'http://local.test').searchParams);
    expect(selected).toEqual({ requested: true, invalid: false, entryId: id });
    expect(policyHistoryReadAllowed(selected, ws)).toBe(true);
  });
  it('refuses duplicate, malformed and workspace-scoped selectors rather than substituting another entry', () => {
    for (const query of [
      `entry=${id}&entry=${id}`,
      'entry=',
      'entry=../private.yaml',
      `entry=${id}&workspace=${ws}`,
      `workspace=${ws}`,
    ]) {
      const selected = policyHistorySelection(new URLSearchParams(query));
      expect(selected.invalid).toBe(true);
      expect(selected.entryId).toBeNull();
      expect(policyHistoryReadAllowed(selected, ws)).toBe(false);
    }
  });
  it('allows a plain history read only after local context exists and produces safe overview links', () => {
    const selected = policyHistorySelection(new URLSearchParams());
    expect(selected).toEqual({ requested: false, invalid: false, entryId: null });
    expect(policyHistoryReadAllowed(selected, ws)).toBe(true);
    expect(policyHistoryReadAllowed(selected, null)).toBe(false);
    expect(policyHistoryHref('private-path')).toBe('/policies/history/');
  });
});
