import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expandVariants } from '../../../src/normalize/normalizer.js';
import { loadBundledRules } from '../../../src/rules/bundle.js';
import { withoutPrefilters } from '../../../src/rules/compile.js';
import { scanContent } from '../../../src/scan/scanner.js';
import {
  ATTACK_CORPUS,
  BENCH_CORPUS,
  BUNDLED_REGEXES,
  PREFILTERED,
  RULE_FIXTURES,
  attackTexts,
  filesUnder,
  rejectedButMatched,
  ruleExamples,
} from './fixtures.js';

/**
 * The prefilter's whole claim: where it says a text cannot match, the regex does not match it.
 * Each test below hands real text to every prefiltered condition of the bundled rules and asks for
 * the conditions where the claim fails. There must be none.
 */
const SLOW = 600_000;

interface Mutation {
  readonly id: string;
  readonly apply: (text: string) => string;
}

/** The attack fuzzer's own mutations, loaded from the CLI sources by path (core does not depend on the CLI). */
async function fuzzerMutations(): Promise<readonly Mutation[]> {
  // A file URL, joined from parts: a Windows path has backslashes and a drive letter.
  const path = pathToFileURL(join(dirname(ATTACK_CORPUS), '..', 'mutate.ts')).href;
  const loaded = (await import(/* @vite-ignore */ path)) as { MUTATIONS: readonly Mutation[] };
  return loaded.MUTATIONS;
}

function variantsOf(texts: Iterable<string>): string[] {
  const found = new Set<string>();
  for (const text of texts) for (const variant of expandVariants(text)) found.add(variant.text);
  return [...found];
}

describe('the prefilter against the files the bench scans', () => {
  it('has a prefilter for most of the bundled regexes', () => {
    expect(BUNDLED_REGEXES.length).toBe(2621);
    expect(PREFILTERED.length / BUNDLED_REGEXES.length).toBeGreaterThanOrEqual(0.8);
  });

  it(
    'never rejects a text of the bench corpus that its regex matches',
    () => {
      const files = filesUnder(BENCH_CORPUS);
      expect(files.length).toBeGreaterThan(100);
      expect(rejectedButMatched(files.map((file) => file.text))).toEqual([]);
    },
    SLOW,
  );

  it(
    'never rejects a text of the rule fixtures that its regex matches',
    () => {
      const files = filesUnder(RULE_FIXTURES);
      expect(files.length).toBeGreaterThan(20);
      expect(rejectedButMatched(variantsOf(files.map((file) => file.text)))).toEqual([]);
    },
    SLOW,
  );
});

describe('the prefilter against the attack corpus', () => {
  it(
    'never rejects a command, a tool result or a file of it, nor any form the scanner reads it in',
    () => {
      const texts = attackTexts();
      expect(texts.length).toBeGreaterThan(30);
      expect(rejectedButMatched(variantsOf(texts))).toEqual([]);
    },
    SLOW,
  );

  it(
    'never rejects a variant the attack fuzzer makes of them',
    async () => {
      const mutations = await fuzzerMutations();
      expect(mutations.length).toBeGreaterThanOrEqual(25);
      const mutated = new Set<string>();
      for (const text of attackTexts())
        for (const mutation of mutations) {
          try {
            mutated.add(mutation.apply(text));
          } catch {
            // A mutation that cannot be applied to this text (an unpaired surrogate) makes no variant.
          }
        }
      expect(mutated.size).toBeGreaterThan(1000);
      expect(rejectedButMatched(variantsOf(mutated))).toEqual([]);
    },
    SLOW,
  );
});

describe('the prefilter against the examples the rules carry', () => {
  it(
    'never rejects an example text, nor any form the scanner reads it in',
    () => {
      const examples = ruleExamples();
      expect(examples.length).toBeGreaterThan(1000);
      expect(rejectedButMatched(variantsOf(examples))).toEqual([]);
    },
    SLOW,
  );
});

describe('the scanner with and without prefilters', () => {
  const rules = loadBundledRules();
  const bare = rules.map(withoutPrefilters);
  const budgetMs = 120_000;

  it(
    'finds the same matches in every text the corpora hold, on every field it reads',
    () => {
      const texts = [
        ...filesUnder(BENCH_CORPUS).map((file) => file.text),
        ...filesUnder(RULE_FIXTURES).map((file) => file.text),
        ...attackTexts(),
        ...ruleExamples().slice(0, 4000),
      ];
      expect(texts.length).toBeGreaterThan(4000);
      for (const text of texts) {
        const context = { tool_response: text, tool_description: text };
        const withPrefilters = scanContent(rules, text, { budgetMs }, context);
        const without = scanContent(bare, text, { budgetMs }, context);
        expect(withPrefilters, text.slice(0, 80)).toEqual(without);
      }
    },
    SLOW,
  );
});
