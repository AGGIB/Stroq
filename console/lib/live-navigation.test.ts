import { describe, expect, it } from 'vitest';
import { liveEventHref, liveHref, liveSelection } from './live-navigation';

const SHA = 'a'.repeat(64);
const query = (text: string) => new URLSearchParams(text);

describe('the Live address', () => {
  it('reads a selection and leaves out what it does not understand', () => {
    expect(
      liveSelection(
        query(`show=denied&session=session-0123456789abcdef&date=2026-11-02&event=${SHA}`),
      ),
    ).toEqual({
      show: 'denied',
      session: 'session-0123456789abcdef',
      date: '2026-11-02',
      text: '',
      event: SHA,
    });
    expect(
      liveSelection(
        query('show=everything&session=../x&date=2026-13-45&event=audit-4&q=' + 'x'.repeat(201)),
      ),
    ).toEqual({ show: 'all', session: null, date: null, text: '', event: null });
  });

  it('takes an event number from an older link', () => {
    expect(liveSelection(query('event=42')).event).toBe('42');
    expect(liveSelection(query('event=0')).event).toBeNull();
  });

  it('writes only what differs from the default, and reads it back', () => {
    expect(liveHref({})).toBe('/live/');
    expect(liveHref({ show: 'all' })).toBe('/live/');
    const href = liveHref({
      show: 'asked',
      session: 'session-0123456789abcdef',
      text: 'rm',
      event: SHA,
    });
    expect(liveSelection(new URL(href, 'http://x').searchParams)).toMatchObject({
      show: 'asked',
      session: 'session-0123456789abcdef',
      text: 'rm',
      event: SHA,
    });
  });

  it('names an event by its digest, or by its number when there is no digest', () => {
    expect(liveEventHref({ id: 'audit-7', evidenceSha: SHA })).toBe(`/live/?event=${SHA}`);
    expect(liveEventHref({ id: 'audit-7' })).toBe('/live/?event=7');
    expect(liveEventHref({ id: 'something-else' })).toBe('/live/');
  });
});
