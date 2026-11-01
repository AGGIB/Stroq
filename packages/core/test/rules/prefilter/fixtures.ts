import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBundledRules } from '../../../src/rules/bundle.js';
import type { CompiledTest } from '../../../src/rules/compile.js';
import { evaluateTest } from '../../../src/scan/matcher.js';
import { TextIndexes } from '../../../src/rules/prefilter/text-index.js';
import { DEFAULT_MAX_CHARS } from '../../../src/scan/scanner.js';

const root = join(import.meta.dirname, '../../../../..');

/** One regex condition of a bundled rule. */
export interface BundledRegex {
  readonly ruleId: string;
  readonly test: CompiledTest;
  readonly regex: RegExp;
}

const rules = loadBundledRules();

export const BUNDLED_REGEXES: readonly BundledRegex[] = rules.flatMap((rule) =>
  rule.tests.flatMap((test) =>
    test.regex === undefined ? [] : [{ ruleId: rule.id, test, regex: test.regex }],
  ),
);

export const PREFILTERED: readonly BundledRegex[] = BUNDLED_REGEXES.filter(
  (entry) => entry.test.prefilter !== undefined,
);

const label = ({ ruleId, regex }: BundledRegex): string =>
  `${ruleId} /${regex.source.slice(0, 90)}/${regex.flags}`;

/**
 * The conditions where the prefilter said the text cannot match and the regex matches it. Each
 * condition is asked the way the scanner asks (`evaluateTest`, which consults the prefilter) and the
 * answer compared with the regex run on its own. An empty list is the proof; anything in it is a bug.
 */
export function rejectedButMatched(
  texts: Iterable<string>,
  entries: readonly BundledRegex[] = PREFILTERED,
): string[] {
  const wrong: string[] = [];
  for (const text of texts) {
    const indexes = new TextIndexes();
    for (const entry of entries) {
      const asked = evaluateTest({ ...entry.test, field: 'content' }, text, {}, indexes);
      if (!asked && entry.regex.test(text))
        wrong.push(`${label(entry)} on ${JSON.stringify(text.slice(0, 80))}`);
    }
  }
  return wrong;
}

/** The text of every file under `dir`, cut where the scanner would cut it. */
export function filesUnder(dir: string): { readonly name: string; readonly text: string }[] {
  const found: { name: string; text: string }[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push({ name: full, text: readFileSync(full, 'utf8').slice(0, DEFAULT_MAX_CHARS) });
    }
  };
  walk(dir);
  return found;
}

export const BENCH_CORPUS = join(root, 'vendor/bench-corpus/files');
export const RULE_FIXTURES = join(root, 'rules/fixtures');
export const ATTACK_CORPUS = join(root, 'packages/cli/src/attack/scenarios/corpus.json');
export const BUNDLE_JSON = join(root, 'packages/core/src/rules.bundle.json');

const TEXT_KEYS = new Set(['command', 'content', 'stdout', 'stderr', 'text', 'body', 'prompt']);

/** The commands, tool results and file bodies of the attack corpus: the text the engine reads. */
export function attackTexts(): readonly string[] {
  const found = new Set<string>();
  const walk = (value: unknown, key: string, inFiles: boolean): void => {
    if (typeof value === 'string') {
      if (TEXT_KEYS.has(key) || key === 'tool_response' || key === 'tool_result' || inFiles)
        found.add(value);
    } else if (Array.isArray(value)) value.forEach((item) => walk(item, key, inFiles));
    else if (value !== null && typeof value === 'object')
      for (const [k, v] of Object.entries(value)) walk(v, k, inFiles || key === 'files');
  };
  walk(JSON.parse(readFileSync(ATTACK_CORPUS, 'utf8')), '', false);
  return [...found].filter((text) => text.length > 0);
}

/** Every string a rule's own `test_cases` holds, apart from what it expects of them. */
export function ruleExamples(): readonly string[] {
  const bundle = JSON.parse(readFileSync(BUNDLE_JSON, 'utf8')) as {
    rules: { test_cases?: unknown }[];
  };
  const found = new Set<string>();
  const walk = (value: unknown, key: string): void => {
    if (typeof value === 'string') {
      if (key !== 'expected') found.add(value);
    } else if (Array.isArray(value)) value.forEach((item) => walk(item, key));
    else if (value !== null && typeof value === 'object')
      for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  for (const rule of bundle.rules) walk(rule.test_cases, '');
  return [...found].filter((text) => text.length > 0);
}
