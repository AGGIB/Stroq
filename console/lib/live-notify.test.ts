import { describe, expect, it } from 'vitest';
import { notificationFor } from './live-notify';
import type { JournalRow } from './journal-view';

const row = (over: Partial<JournalRow> = {}): JournalRow => ({
  seq: 1,
  at: '2026-10-27T10:00:00.000Z',
  phase: 'pre',
  decision: 'allow',
  tool: 'shell',
  classes: [],
  ruleId: null,
  scan: null,
  session: 'session-0123456789abcdef',
  evidenceSha: 'a'.repeat(64),
  ...over,
});

describe('desktop notifications', () => {
  it('stays quiet for allowed and asked actions', () => {
    expect(notificationFor([row(), row({ decision: 'ask' })])).toBeNull();
    expect(notificationFor([])).toBeNull();
  });

  it('names one denied action with the same words as the feed', () => {
    const note = notificationFor([
      row({ decision: 'deny', classes: ['secret.egress'], ruleId: 'deny-secret-egress' }),
    ]);
    expect(note?.title).toBe('Stroq recorded a denied action');
    expect(note?.body).toContain('Run a command');
    expect(note?.body).toContain('deny-secret-egress');
  });

  it('names one flagged result', () => {
    const note = notificationFor([
      row({ phase: 'post', decision: null, scan: 'suspect', tool: 'web' }),
    ]);
    expect(note?.title).toBe('Stroq flagged a result');
    expect(note?.body).toContain('Use the web');
  });

  it('counts several, and says how many of each', () => {
    const note = notificationFor([
      row({ decision: 'deny' }),
      row({ decision: 'deny', seq: 2 }),
      row({ phase: 'post', decision: null, scan: 'suspect', seq: 3 }),
      row({ seq: 4 }),
    ]);
    expect(note).toEqual({
      title: 'Stroq: 3 actions need a look',
      body: '2 denied, 1 flagged. Open Live to see them.',
    });
  });

  it('never says blocked, safe or protected, and carries no session', () => {
    const note = notificationFor([row({ decision: 'deny' }), row({ decision: 'deny', seq: 2 })]);
    expect(JSON.stringify(note)).not.toMatch(/\b(blocked|safe|protected|secure)\b|session-/i);
  });
});
