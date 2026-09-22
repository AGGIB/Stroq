import { describe, expect, it } from 'vitest';
import { collectKeyedStrings } from '../src/cloak/json-strings.js';
import { detectKeyedFields, PERSON_KEYS, PLACE_KEYS } from '../src/cloak/keyed.js';

/**
 * The argument for this detector over NER.
 *
 * An MCP result is JSON, and the cloak already walks its parsed string leaves. The
 * enclosing KEY was in hand the whole time and thrown away before the detector saw
 * it — so `{"first_name":"Peter Parker"}` needed a model to guess what a field the
 * server had already labelled contains. A key is schema: it is a stronger claim
 * than any NER pass can make about the same characters, it costs no dependency,
 * and it holds for names a model trained on English has never seen.
 *
 * What it does not do is a name in prose — `{"text":"call Peter about the invoice"}`
 * — which is the remainder NER would still be for.
 */
describe('detectKeyedFields', () => {
  const span = (text: string, keys: string[]) => detectKeyedFields(text, new Set(keys));

  it('claims the whole leaf when the key names a person', () => {
    expect(span('Peter Parker', ['first_name'])).toEqual([
      { kind: 'name', start: 0, end: 12, value: 'Peter Parker', restorable: true },
    ]);
  });

  it('reads a key however the server spells it', () => {
    for (const key of ['first_name', 'firstName', 'FirstName', 'first-name', 'FIRST_NAME']) {
      expect(span('Peter', [key])).toHaveLength(1);
    }
  });

  it('claims a street address', () => {
    const found = span('20 Ingram Street, Forest Hills', ['street_address']);
    expect(found[0]?.kind).toBe('address');
    expect(found[0]?.value).toBe('20 Ingram Street, Forest Hills');
  });

  it('leaves a bare "name" alone, because most of them are not people', () => {
    // `{"name": "invoice-2026.pdf"}`, `{"name": "acme-corp"}`, `{"name": "main"}`.
    // Cloaking those replaces something the agent needs with a placeholder and
    // protects nobody — the false positive this whole approach exists to avoid.
    expect(span('invoice-2026.pdf', ['name'])).toEqual([]);
    expect(PERSON_KEYS.has('name')).toBe(false);
  });

  it('leaves a bare "address" alone, which is as often an IP or a wallet', () => {
    expect(span('0x71C7656EC7ab88b098defB751B7401B5f6d8976F', ['address'])).toEqual([]);
    expect(PLACE_KEYS.has('address')).toBe(false);
    expect(PLACE_KEYS.has('streetaddress')).toBe(true);
  });

  it('leaves a username alone: it is an identifier the server looks up', () => {
    expect(span('pparker', ['username'])).toEqual([]);
    expect(span('pparker', ['login'])).toEqual([]);
  });

  it('claims a leaf seen under any qualifying key, not only the first', () => {
    expect(span('Peter Parker', ['title', 'display_name'])).toHaveLength(1);
  });

  it('ignores an empty or whitespace-only value', () => {
    expect(span('', ['first_name'])).toEqual([]);
    expect(span('   ', ['first_name'])).toEqual([]);
  });

  it('ignores a value too long to be what its key says it is', () => {
    // A 4,000-character "surname" is prose that landed in the wrong field; a
    // whole-leaf span there would blank a paragraph the agent needs.
    expect(span('a'.repeat(4_000), ['surname'])).toEqual([]);
  });
});

describe('collectKeyedStrings', () => {
  it('carries the key down to the leaf', () => {
    const found = collectKeyedStrings({ customer: { first_name: 'Peter', id: 7 } });
    expect([...(found.get('Peter') ?? [])]).toEqual(['first_name']);
  });

  it('gives an array element the key of the array', () => {
    const found = collectKeyedStrings({ attendees: ['Peter Parker', 'Mary Jane'] });
    expect([...(found.get('Peter Parker') ?? [])]).toEqual(['attendees']);
    expect([...(found.get('Mary Jane') ?? [])]).toEqual(['attendees']);
  });

  it('records every key one repeated value was seen under', () => {
    // The reason this is a SET and the cloak later rewrites by value: the same
    // name under `first_name` and under `note` must be replaced in both, or the
    // result the model reads still carries it.
    const found = collectKeyedStrings({ first_name: 'Peter', note: 'Peter' });
    expect([...(found.get('Peter') ?? [])].sort()).toEqual(['first_name', 'note']);
  });

  it('gives a top-level string no key at all', () => {
    expect([...(collectKeyedStrings('bare').get('bare') ?? [])]).toEqual([]);
  });

  it('stops at the same depth the string walk does', () => {
    let deep: unknown = 'bottom';
    for (let i = 0; i < 200; i += 1) deep = { wrap: deep };
    expect(collectKeyedStrings(deep).has('bottom')).toBe(false);
  });
});
