import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  casedCharacters,
  collapseGroups,
  engineClasses,
  type FoldFlags,
} from '../../../../../scripts/lib/case-fold-derive.js';
import { foldText } from '../../../src/rules/prefilter/case-fold.js';
import { COLLAPSE_I, COLLAPSE_IU } from '../../../src/rules/prefilter/case-fold-table.js';

const MODES: readonly { readonly flags: FoldFlags; readonly table: typeof COLLAPSE_I }[] = [
  { flags: 'i', table: COLLAPSE_I },
  { flags: 'iu', table: COLLAPSE_IU },
];

const classSource = (codes: readonly number[], flags: FoldFlags): string =>
  codes
    .map((code) =>
      flags === 'iu' ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`,
    )
    .join('');

describe('what the engine says about case (the premise of the prefilter)', () => {
  it('equates U+017F with s and U+212A with k only under the u flag', () => {
    expect(/s/iu.test('ſ')).toBe(true);
    expect(/k/iu.test('K')).toBe(true);
    expect(/s/i.test('ſ')).toBe(false);
    expect(/k/i.test('K')).toBe(false);
  });
});

describe('the committed fold table', () => {
  for (const { flags, table } of MODES) {
    it(`is what the engine says for the ${flags} flag`, () => {
      expect(table).toEqual(collapseGroups(engineClasses(flags)));
    });
  }
});

describe('foldText', () => {
  it('leaves a text alone when the regex is case-sensitive', () => {
    expect(foldText('none', 'AbCſ')).toBe('AbCſ');
  });

  it('folds ASCII case', () => {
    expect(foldText('i', 'Ignore PREVIOUS')).toBe('ignore previous');
    expect(foldText('iu', 'Ignore PREVIOUS')).toBe('ignore previous');
  });

  it('folds U+017F and the Kelvin sign into ASCII under u and not otherwise', () => {
    expect(foldText('iu', 'inſide Kinds')).toBe('inside kinds');
    expect(foldText('i', 'inſide')).toBe('inſide');
  });

  it('does not depend on where a sigma stands in the word', () => {
    const forms = ['\u03a3', '\u03c3', '\u03c2'];
    for (const mode of ['i', 'iu'] as const) {
      // `toLowerCase` writes a capital sigma as a final sigma at the end of a word and as a medial
      // one elsewhere; the folded text must not carry the difference.
      const ending = new Set(forms.map((form) => foldText(mode, `x${form}`)));
      const inside = new Set(forms.map((form) => foldText(mode, `x${form}y`)));
      expect(ending.size).toBe(1);
      expect(inside.size).toBe(1);
      expect(`${[...ending][0]}y`).toBe([...inside][0]);
    }
  });

  it('leaves astral text and lone surrogates in place', () => {
    expect(foldText('i', '\u{1F512}x')).toBe('\u{1F512}x');
    expect(foldText('i', '\ud800x')).toBe('\ud800x');
    expect(foldText('iu', '\udc00x')).toBe('\udc00x');
  });
});

describe('the fold against the engine, character by character', () => {
  for (const { flags } of MODES) {
    const mode = flags;

    it(`gives characters the engine equates one folded form (${flags})`, () => {
      for (const members of engineClasses(flags)) {
        const folded = new Set(members.map((code) => foldText(mode, String.fromCodePoint(code))));
        expect([...folded], members.map((m) => m.toString(16)).join(' ')).toHaveLength(1);
      }
    });

    it(`knows every character that has an equal other than itself (${flags})`, () => {
      // Every character outside the cased set must be equal, in the engine, to none of the cased
      // ones; and two characters outside it cannot be equal, since an equality needs a case mapping.
      const cased = casedCharacters(flags);
      const known = new Set(cased);
      const any = new RegExp(`[${classSource(cased, flags)}]`, flags);
      const last = flags === 'iu' ? 0x10ffff : 0xffff;
      const strays: number[] = [];
      for (let code = 0; code <= last; code += 1) {
        if (known.has(code) || (code >= 0xd800 && code <= 0xdfff)) continue;
        if (any.test(String.fromCodePoint(code))) strays.push(code);
      }
      expect(strays).toEqual([]);
    });

    it(`folds texts the engine reads as equal to the same text (${flags})`, () => {
      const classes = engineClasses(flags);
      const universe = [...classes.flat(), ...'abcxyz ./'.split('').map((c) => c.charCodeAt(0))];
      const sameClass = (code: number): readonly number[] =>
        classes.find((members) => members.includes(code)) ?? [code];
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom(...universe), { maxLength: 24 }),
          fc.array(fc.nat(), { minLength: 24, maxLength: 24 }),
          (codes, picks) => {
            const original = codes.map((c) => String.fromCodePoint(c)).join('');
            const swapped = codes
              .map((c, i) => {
                const members = sameClass(c);
                return String.fromCodePoint(members[(picks[i] ?? 0) % members.length] ?? c);
              })
              .join('');
            return foldText(mode, original) === foldText(mode, swapped);
          },
        ),
        { numRuns: 400 },
      );
    });
  }
});
