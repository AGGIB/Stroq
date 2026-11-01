import bundleJson from '../rules.bundle.json' with { type: 'json' };
import { AtrRuleSchema, type AtrRule } from './atr-types.js';
import { compileRules, type CompiledRule } from './compile.js';
import type { PrefilterTable } from './prefilter/prefilter.js';
import { readPrefilterTable } from './prefilter/table-check.js';
import { runtimeBundle } from './runtime-rule.js';

export interface RuleBundle {
  readonly version: 1;
  readonly generatedAt: string;
  readonly rules: readonly AtrRule[];
  readonly disabled: readonly string[];
  /** The literals each rule's patterns require; see `prefilterTable`. Empty when the bundle has none. */
  readonly prefilters: PrefilterTable;
}

let cache: CompiledRule[] | null = null;

export function parseBundle(raw: unknown): RuleBundle {
  const obj = raw as {
    version: number;
    generatedAt: string;
    rules: unknown[];
    disabled: string[];
    prefilters?: unknown;
  };
  const rules = obj.rules.map((r) => AtrRuleSchema.parse(r));
  // A table that does not read as one is not trusted: the patterns are read again instead.
  const table = readPrefilterTable(obj.prefilters);
  return {
    version: 1,
    generatedAt: obj.generatedAt,
    rules,
    disabled: obj.disabled ?? [],
    prefilters: table ?? {},
  };
}

export function loadBundledRules(): CompiledRule[] {
  if (cache) return cache;
  // The shipped CLI already holds only this projection; from source it is the whole file.
  const bundle = parseBundle(runtimeBundle(bundleJson));
  const disabled = new Set(bundle.disabled);
  cache = compileRules(
    bundle.rules.filter((r) => !disabled.has(r.id)),
    bundle.prefilters,
  ).compiled;
  return cache;
}
