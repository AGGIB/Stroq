import { describe, expect, it } from 'vitest';
import type { ToolCall } from './data';
import {
  activityEventHref,
  activityEventSelection,
  activityFindingHref,
} from './activity-navigation';

const sha = 'a'.repeat(64);
const call = (changes: Record<string, unknown> = {}): ToolCall => ({
  id: 'audit-17',
  evidenceSha: sha,
  decision: 'block',
  label: 'Policy denied a tool call',
  raw: 'Command and content withheld',
  agent: 'Unknown host',
  date: '2026-10-26',
  time: '09:00:00',
  ...changes,
});
const select = (
  query: string,
  calls: readonly ToolCall[] = [call()],
  source: 'local' | 'demo' = 'local',
) => activityEventSelection(new URLSearchParams(query), calls, source);

describe('exact Activity navigation', () => {
  it('binds new event links to the captured raw-line digest and keeps old/demo links readable', () => {
    expect(activityEventHref(call())).toBe(`/activity/event/?id=audit-17&evidence=${sha}`);
    expect(activityEventHref(call({ evidenceSha: undefined }))).toBe(
      '/activity/event/?id=audit-17',
    );
    expect(activityEventHref(call({ id: 'demo-17', evidenceSha: undefined }))).toBe(
      '/activity/event/?id=demo-17',
    );
  });

  it('selects the full exact finding even when its independent review may be closed', () => {
    expect(select(`id=audit-17&evidence=${sha}`)).toEqual({
      call: call(),
      binding: 'exact',
      error: null,
    });
    expect(activityFindingHref(call(), 'local')).toBe(`/incidents/?status=all&id=incident-${sha}`);
    for (const decision of ['ask', 'flag'] as const)
      expect(activityFindingHref(call({ decision }), 'local')).toContain(`incident-${sha}`);
  });

  it('does not fall back to another record with the same sequence after changed or missing evidence', () => {
    for (const changes of [{ evidenceSha: 'b'.repeat(64) }, { evidenceSha: undefined }])
      expect(select(`id=audit-17&evidence=${sha}`, [call(changes)])).toEqual({
        call: null,
        binding: null,
        error: 'stale',
      });
    expect(select(`id=audit-17&evidence=${sha}`, [])).toEqual({
      call: null,
      binding: null,
      error: 'missing',
    });
  });

  it('refuses malformed, empty, duplicate and demo evidence selectors', () => {
    for (const query of [
      'id=audit-17&evidence=',
      'id=audit-17&evidence=bad',
      `id=audit-17&evidence=${sha.toUpperCase()}`,
      `id=audit-17&evidence=${sha}&evidence=${sha}`,
      `id=audit-17&id=audit-17&evidence=${sha}`,
    ])
      expect(select(query)).toEqual({ call: null, binding: null, error: 'invalid' });
    expect(select(`id=audit-17&evidence=${sha}`, [call()], 'demo')).toEqual({
      call: null,
      binding: null,
      error: 'invalid',
    });
  });

  it('labels legacy local IDs as the current window and leaves demo selection unchanged', () => {
    expect(select('id=audit-17')).toEqual({ call: call(), binding: 'current-window', error: null });
    expect(select('id=demo-17', [call({ id: 'demo-17', evidenceSha: undefined })], 'demo')).toEqual(
      { call: call({ id: 'demo-17', evidenceSha: undefined }), binding: 'demo', error: null },
    );
  });

  it('never claims allow, legacy, malformed or demo events are an authoritative finding', () => {
    for (const value of [
      call({ decision: 'allow' }),
      call({ decision: 'nj' }),
      call({ evidenceSha: undefined }),
      call({ evidenceSha: 'bad' }),
      call({ id: 'audit-0' }),
      call({ id: 'demo-17' }),
    ])
      expect(activityFindingHref(value, 'local')).toBeNull();
    expect(activityFindingHref(call(), 'demo')).toBeNull();
  });
});
