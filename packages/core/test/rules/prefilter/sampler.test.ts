import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { engineClasses } from '../../../../../scripts/lib/case-fold-derive.js';
import { foldText } from '../../../src/rules/prefilter/case-fold.js';
import { buildPrefilter, foldModeOf, mayMatch } from '../../../src/rules/prefilter/prefilter.js';
import { requiredLiterals } from '../../../src/rules/prefilter/requirements.js';
import { TextIndexes } from '../../../src/rules/prefilter/text-index.js';
import { Random, randomNode, render, sample, type Kind } from './sampler.js';

/**
 * Random patterns, each with a text it matches that the generator wrote without reading the pattern.
 * For every one: the requirements reader must not rule that text out, under the case rules of the
 * flags, with the text's characters swapped for any the engine equates to them.
 */
const CLASSES: Readonly<Record<'i' | 'iu', readonly (readonly number[])[]>> = {
  i: engineClasses('i'),
  iu: engineClasses('iu'),
};

function equivalent(char: string, kind: Kind, random: Random): string {
  const mode = kind.unicode ? 'iu' : 'i';
  const code = char.codePointAt(0) ?? 0;
  const members = CLASSES[mode].find((group) => group.includes(code));
  const swapped = members === undefined ? char : String.fromCodePoint(random.pick(members));
  return random.chance(0.3)
    ? random.chance(0.5)
      ? swapped.toUpperCase()
      : swapped.toLowerCase()
    : swapped;
}

/** Characters of a text, as the engine reads them: code points with `u`, code units without. */
const charsOf = (text: string, kind: Kind): string[] => (kind.unicode ? [...text] : text.split(''));

interface Case {
  readonly source: string;
  readonly flags: string;
  readonly text: string;
}

function caseFor(seed: number): Case {
  const random = new Random(seed);
  const kind: Kind = { unicode: random.chance(0.4), ignoreCase: random.chance(0.5) };
  const node = randomNode(random, kind, 3);
  const anchored = random.chance(0.15);
  const source = `${anchored ? '^' : ''}${render(node, kind)}${anchored ? '$' : ''}`;
  const flags = `${kind.ignoreCase ? 'i' : ''}${kind.unicode ? 'u' : ''}`;
  let text = sample(node, random, kind);
  if (kind.ignoreCase)
    text = charsOf(text, kind)
      .map((char) => equivalent(char, kind, random))
      .join('');
  if (!anchored) text = `${random.pick(['', 'zz ', '​'])}${text}${random.pick(['', ' yy', 'ſ'])}`;
  return { source, flags, text };
}

const SEEDS = 40_000;

describe('requiredLiterals against patterns that come with a matching text', () => {
  it('never rules out the text its pattern matches, for any literal length', () => {
    let compiled = 0;
    let withRequirement = 0;
    let wrongSample = 0;
    const failures: string[] = [];
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
        const { source, flags, text } = caseFor(seed);
        let regex: RegExp;
        try {
          regex = new RegExp(source, flags);
        } catch {
          return true;
        }
        compiled += 1;
        if (!regex.test(text)) {
          wrongSample += 1;
          return true;
        }
        const required = requiredLiterals(regex.source, regex.flags);
        if (required === null) return true;
        withRequirement += 1;
        const fold = foldModeOf(regex.flags);
        const folded = foldText(fold, text);
        const held = required.some((literal) => folded.includes(foldText(fold, literal)));
        if (!held && failures.length < 5)
          failures.push(
            `${seed}: /${source}/${flags} on ${JSON.stringify(text)} needs ${JSON.stringify(required)}`,
          );
        return held;
      }),
      { numRuns: SEEDS },
    );
    expect(failures).toEqual([]);
    // The generator must mostly write patterns that compile and texts that match, and the reader
    // must find a requirement in many of them, or this test proves little.
    expect(compiled / SEEDS).toBeGreaterThan(0.95);
    expect(wrongSample / compiled).toBeLessThan(0.01);
    expect(withRequirement / compiled).toBeGreaterThan(0.3);
  }, 120_000);

  it('never rules out the text through the prefilter the engine builds from them', () => {
    const indexes = (): TextIndexes => new TextIndexes();
    let built = 0;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
        const { source, flags, text } = caseFor(seed);
        let regex: RegExp;
        try {
          regex = new RegExp(source, flags);
        } catch {
          return true;
        }
        if (!regex.test(text)) return true;
        const prefilter = buildPrefilter(requiredLiterals(regex.source, regex.flags), regex.flags);
        if (prefilter === undefined) return true;
        built += 1;
        return mayMatch(prefilter, text, indexes());
      }),
      { numRuns: SEEDS },
    );
    expect(built).toBeGreaterThan(500);
  }, 120_000);
});

describe('requiredLiterals is not vacuous', () => {
  it('rules out most unrelated text for the patterns it finds a requirement in', () => {
    let tried = 0;
    let ruledOut = 0;
    for (let seed = 0; seed < 5000; seed += 1) {
      const { source, flags } = caseFor(seed);
      let regex: RegExp;
      try {
        regex = new RegExp(source, flags);
      } catch {
        continue;
      }
      const prefilter = buildPrefilter(requiredLiterals(regex.source, regex.flags), regex.flags);
      if (prefilter === undefined) continue;
      tried += 1;
      if (!mayMatch(prefilter, 'the quick brown fox 12345 jumps over', new TextIndexes()))
        ruledOut += 1;
    }
    expect(tried).toBeGreaterThan(100);
    expect(ruledOut / tried).toBeGreaterThan(0.7);
  });
});
