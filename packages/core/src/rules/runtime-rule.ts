/**
 * The part of a bundled rule that the engine reads, and nothing else.
 *
 * `rules.bundle.json` is the vendored corpus as it was imported: each rule's own test cases, its
 * compliance mapping, its description, references and evasion notes. That is about three quarters
 * of its 5.7 MB, and the engine reads none of it: `compileRule` takes the id, title, severity,
 * category, scan target, and the operator, field and value of each condition. The CLI's build
 * ships this projection (`packages/cli/tsup.config.ts`), and every hook call, a new process each
 * time, stopped parsing and building the rest.
 *
 * `loadBundledRules` applies it too, so the tests, which load the whole file from source, run the
 * same reading the shipped bundle does. Applied twice it changes nothing.
 *
 * Only keys are dropped, never values: whatever is kept is the value as written, and whatever is not
 * an object where an object was expected is passed through unchanged, so `AtrRuleSchema` still
 * rejects a malformed rule exactly as it would have. What the schema no longer sees is what it only
 * ever validated without anything reading it (`test_cases`, `status`, `tags.confidence`, a
 * condition's `description`); the build's own gates read the whole file.
 */

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A copy of `from` holding only `keys`, each as written; a key that is absent stays absent. */
function only(from: Json, keys: readonly string[]): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const key of keys) if (Object.hasOwn(from, key)) kept[key] = from[key];
  return kept;
}

const RULE_KEYS = ['id', 'title', 'severity', 'tags', 'detection'] as const;
const TAG_KEYS = ['category', 'scan_target', 'stroq_surfaces'] as const;
const DETECTION_KEYS = ['condition', 'conditions'] as const;
const CONDITION_KEYS = ['field', 'operator', 'value', 'stroq_surfaces'] as const;

export function runtimeRule(rule: unknown): unknown {
  if (!isObject(rule)) return rule;
  const kept = only(rule, RULE_KEYS);
  if (isObject(kept['tags'])) kept['tags'] = only(kept['tags'], TAG_KEYS);
  const detection = kept['detection'];
  if (isObject(detection)) {
    const read = only(detection, DETECTION_KEYS);
    const conditions = read['conditions'];
    if (Array.isArray(conditions))
      read['conditions'] = conditions.map((c: unknown) =>
        isObject(c) ? only(c, CONDITION_KEYS) : c,
      );
    kept['detection'] = read;
  }
  return kept;
}

/** The bundle with each rule projected; its other keys (`version`, `disabled`, …) as they are. */
export function runtimeBundle(bundle: unknown): unknown {
  if (!isObject(bundle) || !Array.isArray(bundle['rules'])) return bundle;
  return { ...bundle, rules: bundle['rules'].map(runtimeRule) };
}
