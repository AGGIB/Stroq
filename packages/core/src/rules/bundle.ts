import bundleJson from '../rules.bundle.json' with { type: 'json' };
import { AtrRuleSchema, type AtrRule } from './atr-types.js';
import { compileRules, type CompiledRule } from './compile.js';

export interface RuleBundle {
  readonly version: 1;
  readonly generatedAt: string;
  readonly rules: readonly AtrRule[];
  readonly disabled: readonly string[];
}

let cache: CompiledRule[] | null = null;

export function parseBundle(raw: unknown): RuleBundle {
  const obj = raw as { version: number; generatedAt: string; rules: unknown[]; disabled: string[] };
  const rules = obj.rules.map((r) => AtrRuleSchema.parse(r));
  return { version: 1, generatedAt: obj.generatedAt, rules, disabled: obj.disabled ?? [] };
}

export function loadBundledRules(): CompiledRule[] {
  if (cache) return cache;
  const bundle = parseBundle(bundleJson);
  const disabled = new Set(bundle.disabled);
  cache = compileRules(bundle.rules.filter((r) => !disabled.has(r.id))).compiled;
  return cache;
}
