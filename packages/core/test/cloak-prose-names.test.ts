import { describe, expect, it } from 'vitest';
import { detectKnownNames, nameNeedles } from '../src/cloak/prose-names.js';

const spans = (text: string, names: readonly string[]) =>
  detectKnownNames(text, nameNeedles(names)).map((s) => [s.start, s.end, s.value]);

describe('nameNeedles', () => {
  it('looks for the whole name and for each of its parts', () => {
    expect(nameNeedles(['Peter Parker'])).toEqual(['Peter Parker', 'Parker', 'Peter']);
  });

  it('puts the longest first, so a full name wins over either half', () => {
    expect(nameNeedles(['Ada', 'Ada Lovelace'])[0]).toBe('Ada Lovelace');
  });

  it('drops a part too short to mean anything on its own', () => {
    // `Bo` in prose is a syllable far more often than it is this person.
    expect(nameNeedles(['Bo Jansen'])).toEqual(['Bo Jansen', 'Jansen']);
  });

  it('keeps a name that is a single part', () => {
    expect(nameNeedles(['Cher'])).toEqual(['Cher']);
  });
});

describe('detectKnownNames', () => {
  it('claims a labelled name where it appears again in prose', () => {
    expect(spans('call Peter about the invoice', ['Peter Parker'])).toEqual([[5, 10, 'Peter']]);
  });

  it('prefers the full name over its parts when both would match', () => {
    expect(spans('met Peter Parker today', ['Peter Parker'])).toEqual([[4, 16, 'Peter Parker']]);
  });

  it('claims every occurrence, not just the first', () => {
    expect(spans('Parker wrote, then Parker left', ['Parker'])).toEqual([
      [0, 6, 'Parker'],
      [19, 25, 'Parker'],
    ]);
  });

  it('stops at a word boundary rather than inside a longer word', () => {
    // `Parkerville` is a place, and half of it is not this person.
    expect(spans('the Parkerville office', ['Parker'])).toEqual([]);
  });

  it('respects a boundary made of letters no ASCII rule knows about', () => {
    expect(spans('Ааронов писал', ['Аарон'])).toEqual([]);
    expect(spans('Аарон писал', ['Аарон'])).toEqual([[0, 5, 'Аарон']]);
  });

  it('matches case-sensitively, because in prose a person is capitalised', () => {
    // This is the rule that keeps an ordinary sentence readable: `mark the task`
    // is a verb, and the model needs to read it as one.
    expect(spans('mark the task as done', ['Mark Hughes'])).toEqual([]);
  });

  it('leaves a name that is also an ordinary word alone at the start of a sentence', () => {
    expect(spans('Mark the task as done.', ['Mark Hughes'])).toEqual([]);
    expect(spans('Please ask Mark about it.', ['Mark Hughes'])).toEqual([[11, 15, 'Mark']]);
  });

  it('treats the position after a full stop as the start of a sentence too', () => {
    expect(spans('Done. Will follow up.', ['Will Smith'])).toEqual([]);
  });

  it('claims an unambiguous name even at the start of a sentence', () => {
    expect(spans('Parker will present.', ['Parker'])).toEqual([[0, 6, 'Parker']]);
  });

  it('reports a name as restorable, so the server still gets the real value back', () => {
    const [span] = detectKnownNames('ask Parker', nameNeedles(['Parker']));
    expect(span).toMatchObject({ kind: 'name', restorable: true });
  });

  it('finds nothing when there is nothing labelled to look for', () => {
    expect(spans('call Peter about the invoice', [])).toEqual([]);
  });

  it('never returns overlapping spans', () => {
    const found = detectKnownNames('Peter Parker and Peter', nameNeedles(['Peter Parker']));
    for (let i = 1; i < found.length; i += 1) {
      expect(found[i]!.start).toBeGreaterThanOrEqual(found[i - 1]!.end);
    }
  });

  it('bounds how many names it will look for at once', () => {
    const many = Array.from({ length: 500 }, (_, i) => `Namxx${i}`);
    expect(nameNeedles(many).length).toBeLessThanOrEqual(64);
  });
});
