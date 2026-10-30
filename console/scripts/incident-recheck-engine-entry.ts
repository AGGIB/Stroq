import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { ACTION_CLASSES, type ActionClass } from '../../packages/core/src/types.js';
import { DEFAULT_POLICY } from '../../packages/core/src/policy/default-policy.js';
import { evaluatePolicy } from '../../packages/core/src/policy/evaluate.js';
import { PolicySchema } from '../../packages/core/src/policy/policy-types.js';
import { policySha256 } from '../../packages/cli/src/policy/digest.js';
import { readYaml } from '../../packages/cli/src/policy/yaml.js';
import { unknownFieldPaths } from '../../packages/cli/src/policy/unknown-fields.js';

const MAX_RULES = 512;
const KNOWN_CLASSES = new Set<string>(ACTION_CLASSES);

/** No command reclassification or historical taint inference occurs in this comparison. */
export function compareRecordedClasses(text: string | null, recorded: unknown) {
  if (
    !Array.isArray(recorded) ||
    recorded.length > 128 ||
    recorded.some((value) => typeof value !== 'string' || !KNOWN_CLASSES.has(value))
  )
    throw new Error('unsupported-evidence');
  const classes = [...new Set(recorded)] as ActionClass[];
  const yaml = text === null ? { ok: true as const, value: DEFAULT_POLICY } : readYaml(text);
  if (!yaml.ok || unknownFieldPaths(yaml.value).length) throw new Error('policy-invalid');
  const parsed = PolicySchema.safeParse(yaml.value);
  if (!parsed.success || parsed.data.rules.length > MAX_RULES) throw new Error('policy-invalid');
  const policy = parsed.data;
  // Rule IDs are only result labels, never match predicates. Private ordinal labels preserve
  // evaluation while making duplicate user-provided IDs unambiguous without returning them.
  const ordinalPolicy = {
    ...policy,
    rules: policy.rules.map((rule, index) => ({ ...rule, id: `ordinal-${index}` })),
  };
  const scenarios = (['none', 'suspect'] as const).map((taint) => {
    const decision = evaluatePolicy(ordinalPolicy, classes, taint === 'none' ? null : 'suspect');
    const index = decision.ruleId === null ? null : Number(decision.ruleId.slice(8));
    const rule = index === null ? null : policy.rules[index];
    if (index !== null && (!Number.isSafeInteger(index) || !rule)) throw new Error('engine-failed');
    return {
      taint,
      effect: decision.effect,
      matchedRule: rule
        ? { index, classes: [...new Set(rule.when.classes)], taint: rule.when.taint }
        : null,
    };
  });
  return {
    semanticSha: policySha256(policy),
    rules: policy.rules.length,
    classes,
    scenarios,
  };
}

if (!isMainThread) {
  Promise.resolve()
    .then(() => compareRecordedClasses(workerData.text, workerData.classes))
    .then(
      (value) => parentPort?.postMessage({ ok: true, value }),
      (error: unknown) =>
        parentPort?.postMessage({
          ok: false,
          error:
            error instanceof Error &&
            ['unsupported-evidence', 'policy-invalid'].includes(error.message)
              ? error.message
              : 'engine-failed',
        }),
    );
}
