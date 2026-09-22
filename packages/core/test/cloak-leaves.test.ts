import { describe, expect, it } from 'vitest';
import { detectAcrossLeaves } from '../src/cloak/detector.js';
import { collectKeyedStrings } from '../src/cloak/json-strings.js';
import { detectKeyedFields } from '../src/cloak/keyed.js';
import type { CloakDetector, CloakSpan } from '../src/cloak/types.js';

/** Only the keyed detector, so these tests are about the second pass and nothing else. */
const keyedOnly: CloakDetector = {
  detect: (text, keys) => detectKeyedFields(text, keys ?? new Set()),
};

const claimed = async (value: unknown): Promise<Record<string, string[]>> => {
  const found = await detectAcrossLeaves(collectKeyedStrings(value), keyedOnly);
  const out: Record<string, string[]> = {};
  for (const [text, spans] of found) out[text] = spans.map((s: CloakSpan) => s.value);
  return out;
};

describe('detectAcrossLeaves', () => {
  it('claims a name in prose once another field in the same result labelled it', async () => {
    expect(
      await claimed({
        first_name: 'Peter Parker',
        note: 'call Peter about the invoice',
      }),
    ).toEqual({
      'Peter Parker': ['Peter Parker'],
      'call Peter about the invoice': ['Peter'],
    });
  });

  it('claims the labelled leaf exactly once, not again through its own name', async () => {
    const found = await claimed({ surname: 'Lovelace' });
    expect(found['Lovelace']).toEqual(['Lovelace']);
  });

  it('reaches prose in a different branch of the same result', async () => {
    expect(
      await claimed({
        attendees: [{ display_name: 'Ada Lovelace' }],
        agenda: { summary: 'Ada opens, then questions' },
      }),
    ).toEqual({
      'Ada Lovelace': ['Ada Lovelace'],
      'Ada opens, then questions': ['Ada'],
    });
  });

  it('does nothing extra when the result labelled no one', async () => {
    expect(await claimed({ note: 'call Peter about the invoice' })).toEqual({});
  });

  it('leaves a field the key rules deliberately exclude out of the second pass too', async () => {
    // A bare `name` is a project or a file at least as often as a person, so it
    // claims nothing — and therefore teaches the prose pass nothing either.
    expect(await claimed({ name: 'Blinq', readme: 'Blinq is a widget' })).toEqual({});
  });

  it('keeps a stronger claim over a prose one where they overlap', async () => {
    // `Peter Parker` is labelled, and the prose leaf holds the full name: the span
    // covers both words at once rather than leaving `Parker` beside a placeholder.
    const found = await claimed({
      first_name: 'Peter Parker',
      note: 'Peter Parker signed',
    });
    expect(found['Peter Parker signed']).toEqual(['Peter Parker']);
  });
});
