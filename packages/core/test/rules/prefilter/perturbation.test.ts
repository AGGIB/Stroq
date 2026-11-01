import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluateTest } from '../../../src/scan/matcher.js';
import { requiredLiterals } from '../../../src/rules/prefilter/requirements.js';
import { TextIndexes } from '../../../src/rules/prefilter/text-index.js';
import { BUNDLE_JSON, PREFILTERED, type BundledRegex } from './fixtures.js';
import { Random } from './sampler.js';

/**
 * Texts that are close to what a rule is written for, and then bent the ways an attacker bends
 * them: any case, U+017F for `s`, the Kelvin sign for `k`, zero-width characters, full-width and
 * mathematical look-alikes, noise around. Wherever the prefilter says the text cannot match, the
 * regex must not match it.
 */
const ZERO_WIDTH = ['​', '‌', '‍', '⁠', '﻿', '­', '\u{e0020}'];
const NOISE = [' ', '\n', 'lorem ipsum ', 'éè ', '中文', '<!-- ', ' -->', '12345 ', '\u{1f600}'];

const fullWidth = (ch: string): string =>
  ch >= '!' && ch <= '~' ? String.fromCodePoint(ch.charCodeAt(0) + 0xfee0) : ch;
const mathBold = (ch: string): string =>
  /[A-Z]/.test(ch)
    ? String.fromCodePoint(0x1d400 + ch.charCodeAt(0) - 65)
    : /[a-z]/.test(ch)
      ? String.fromCodePoint(0x1d41a + ch.charCodeAt(0) - 97)
      : ch;

type Bend = (ch: string, random: Random) => string;
const BENDS: readonly Bend[] = [
  (ch, random) => (random.chance(0.5) ? ch.toUpperCase() : ch.toLowerCase()),
  (ch) => (/[sS]/.test(ch) ? 'ſ' : ch),
  (ch) => (/[kK]/.test(ch) ? 'K' : ch),
  (ch, random) => `${ch}${random.pick(ZERO_WIDTH)}`,
  (ch) => fullWidth(ch),
  (ch) => mathBold(ch),
];

/** `text` with a share of its characters bent, and noise around it. */
function bend(text: string, random: Random): string {
  const rate = random.pick([0, 0, 0.1, 0.4, 1]);
  const bender = random.pick(BENDS);
  const bent = [...text].map((ch) => (random.chance(rate) ? bender(ch, random) : ch)).join('');
  return `${random.chance(0.4) ? random.pick(NOISE) : ''}${bent}${random.chance(0.4) ? random.pick(NOISE) : ''}`;
}

interface Examples {
  readonly examples: readonly string[];
  readonly entries: readonly BundledRegex[];
}

/** For each rule: the texts its own `true_positives` give, and its prefiltered conditions. */
function exampleGroups(): readonly Examples[] {
  const bundle = JSON.parse(readFileSync(BUNDLE_JSON, 'utf8')) as {
    rules: { id: string; test_cases?: { true_positives?: { input?: unknown }[] } }[];
  };
  return bundle.rules.flatMap((rule) => {
    const entries = PREFILTERED.filter((entry) => entry.ruleId === rule.id);
    const examples = (rule.test_cases?.true_positives ?? [])
      .map((example) => example.input)
      .filter((input): input is string => typeof input === 'string' && input.length > 0);
    return entries.length > 0 && examples.length > 0 ? [{ examples, entries }] : [];
  });
}

const GROUPS = exampleGroups();

function disagreement(entry: BundledRegex, text: string, indexes: TextIndexes): string | null {
  const asked = evaluateTest({ ...entry.test, field: 'content' }, text, {}, indexes);
  return !asked && entry.regex.test(text)
    ? `${entry.ruleId} /${entry.regex.source.slice(0, 80)}/${entry.regex.flags} on ${JSON.stringify(text.slice(0, 100))}`
    : null;
}

describe('the prefilter against bent examples', () => {
  it('never rejects a bent true positive of its own rule that the regex matches', () => {
    expect(GROUPS.length).toBeGreaterThan(400);
    let matched = 0;
    const wrong: string[] = [];
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
        const random = new Random(seed);
        for (const group of GROUPS) {
          const text = bend(random.pick(group.examples), random);
          const indexes = new TextIndexes();
          for (const entry of group.entries) {
            const problem = disagreement(entry, text, indexes);
            if (problem !== null) wrong.push(problem);
            else if (entry.regex.test(text)) matched += 1;
          }
        }
        return wrong.length === 0;
      }),
      { numRuns: 120 },
    );
    expect(wrong.slice(0, 5)).toEqual([]);
    // A test about matching texts must see some: every bend keeps a share of the examples matching.
    expect(matched).toBeGreaterThan(20_000);
  }, 300_000);

  it('never rejects the literals of a regex, bent, that the regex matches', () => {
    const wrong: string[] = [];
    let matched = 0;
    const literals = PREFILTERED.map((entry) => ({
      entry,
      literals: requiredLiterals(entry.regex.source, entry.regex.flags) ?? [],
    }));
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
        const random = new Random(seed);
        for (const { entry, literals: own } of literals) {
          const text = bend(`${random.pick(own)} ${random.pick(own)}`, random);
          const problem = disagreement(entry, text, new TextIndexes());
          if (problem !== null) wrong.push(problem);
          else if (entry.regex.test(text)) matched += 1;
        }
        return wrong.length === 0;
      }),
      { numRuns: 40 },
    );
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(matched).toBeGreaterThan(500);
  }, 300_000);
});
