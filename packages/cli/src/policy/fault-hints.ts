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

/** The same for the fields of a file of cases (`stroq policy test --cases`). */
const CASE_HINTS: readonly (readonly [pattern: RegExp, fix: string])[] = [
  [/^cases$/, 'put at least one case in the file'],
  [/^cases\.\d+$/, 'a case has id, steps and, for ordinary work, expect; remove any other field'],
  [/\.id$/, 'give each case an id of its own, 1 to 120 characters'],
  [
    /\.expect$/,
    'a tool call expects allow, ask or deny, a tool result clean or suspect, and the attack at the end is never allowed',
  ],
  [
    /\.event$/,
    'an event needs session_id, hook_event_name, tool_name and tool_input, as in corpus.json',
  ],
  [/\.steps$/, 'a case needs at least one step, and the last one is a tool call (PreToolUse)'],
  [
    /\.(?:files|links)$/,
    'paths are relative to the project folder, with no ..; a link points to __HOME__/... or __CWD__/...',
  ],
];

const CASE_FALLBACK = 'correct the field named, then run the command again';

export function fixForCaseField(path: string): string {
  return CASE_HINTS.find(([pattern]) => pattern.test(path))?.[1] ?? CASE_FALLBACK;
}
