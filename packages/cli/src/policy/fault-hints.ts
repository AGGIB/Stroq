/**
 * What to change for a field of a policy that does not match the schema, one line each, from a fixed
 * list: the text is ours, so nothing from the file can reach it. Matched on the dotted path of the
 * field, so `rules.3.when.classes.1` is a class name wherever it is.
 */
const HINTS: readonly (readonly [pattern: RegExp, fix: string])[] = [
  [/^version$/, 'set version: 1'],
  [/^threshold$/, 'set threshold to a number from 0 to 1 (the default policy uses 0.6)'],
  [/^default$/, 'set default to allow, deny or ask'],
  [/^rules$/, 'rules must be a list of rules'],
  [/^rules\.\d+$/, 'each rule needs id, effect, reason and when'],
  [/\.effect$/, 'set effect to allow, deny or ask'],
  [/\.id$/, 'give the rule an id, which is text and not empty'],
  [/\.reason$/, 'give the rule a reason, which is text and not empty'],
  [/\.when$/, 'give the rule a when: with a classes: list'],
  [/\.taint$/, 'set taint to any, none or suspect'],
  [
    /\.classes\.\d+$/,
    'use an action class name as the default policy writes them, such as secret.egress',
  ],
  [/\.classes$/, 'list at least one action class in classes'],
];

const FALLBACK = 'correct the field named above, then run stroq policy check again';

export function fixForField(path: string): string {
  return HINTS.find(([pattern]) => pattern.test(path))?.[1] ?? FALLBACK;
}
