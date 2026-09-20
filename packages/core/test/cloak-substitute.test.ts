import { describe, expect, it } from 'vitest';
import {
  applySpans,
  mergeSpans,
  mintPlaceholder,
  PLACEHOLDER_RE,
} from '../src/cloak/substitute.js';
import type { CloakSpan } from '../src/cloak/types.js';

const span = (kind: CloakSpan['kind'], start: number, end: number, text: string): CloakSpan => ({
  kind,
  start,
  end,
  value: text.slice(start, end),
  restorable: kind !== 'secret',
});

describe('mergeSpans', () => {
  it('sorts by position and drops a later span that overlaps an earlier one', () => {
    const text = 'aaaa@bb.example';
    const merged = mergeSpans([span('email', 0, 15, text), span('phone', 4, 10, text)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.kind).toBe('email');
  });

  it('prefers a secret span over a pattern span covering the same characters', () => {
    const text = 'value a@b.example here';
    const merged = mergeSpans([span('email', 6, 17, text), span('secret', 6, 17, text)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.kind).toBe('secret');
  });

  it('keeps two spans that merely touch', () => {
    const text = 'abcdef';
    expect(mergeSpans([span('email', 0, 3, text), span('email', 3, 6, text)])).toHaveLength(2);
  });
});

describe('mintPlaceholder', () => {
  it('produces a placeholder matching the documented shape', () => {
    expect(mintPlaceholder('email', 1)).toBe('[STROQ_EMAIL_1]');
    expect(mintPlaceholder('secret', 42)).toBe('[STROQ_SECRET_42]');
    expect(PLACEHOLDER_RE.test(mintPlaceholder('card', 3))).toBe(true);
  });
});

describe('applySpans', () => {
  /**
   * Position-keyed, so the stub cannot depend on the order `applySpans` walks in —
   * which is the thing under test. In the real flow the store assigns every
   * placeholder up front and the callback is a pure lookup for exactly this reason.
   */
  const byPosition = (s: CloakSpan) => mintPlaceholder(s.kind, s.start + 1);

  it('replaces right-to-left so earlier offsets stay valid', () => {
    // The placeholders are LONGER than the values they replace, so a left-to-right
    // implementation would cut the second span at a shifted, wrong offset.
    const text = 'a@b.example and c@d.example';
    const spans = mergeSpans([span('email', 0, 11, text), span('email', 16, 27, text)]);
    const out = applySpans(text, spans, byPosition);
    expect(out.text).toBe('[STROQ_EMAIL_1] and [STROQ_EMAIL_17]');
    expect(out.replacements.map((r) => r.placeholder)).toEqual([
      '[STROQ_EMAIL_1]',
      '[STROQ_EMAIL_17]',
    ]);
  });

  it('gives the same value the same placeholder when the minter says so', () => {
    const text = 'a@b.example and a@b.example';
    const spans = mergeSpans([span('email', 0, 11, text), span('email', 16, 27, text)]);
    const out = applySpans(text, spans, () => '[STROQ_EMAIL_1]');
    expect(out.text).toBe('[STROQ_EMAIL_1] and [STROQ_EMAIL_1]');
    // One replacement RECORD per occurrence, so the audit count is honest.
    expect(out.replacements).toHaveLength(2);
  });

  it('returns the text unchanged and no replacements for an empty span list', () => {
    expect(applySpans('untouched', [], byPosition)).toEqual({
      text: 'untouched',
      replacements: [],
    });
  });
});
