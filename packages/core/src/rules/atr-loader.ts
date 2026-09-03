import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { AtrRuleSchema, type AtrRule } from './atr-types.js';

export interface SkippedRule {
  readonly file: string;
  readonly reason: string;
}

export interface LoadResult {
  readonly rules: readonly AtrRule[];
  readonly skipped: readonly SkippedRule[];
}

export function parseRule(yamlText: string, file: string): { rule?: AtrRule; error?: string } {
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch (err) {
    return { error: `${file}: invalid YAML: ${(err as Error).message}` };
  }
  const result = AtrRuleSchema.safeParse(doc);
  if (result.success) return { rule: result.data };
  const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  return { error: `${file}: ${issues.join('; ')}` };
}

export function listRuleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listRuleFiles(full));
    else if (/\.ya?ml$/.test(name)) out.push(full);
  }
  return out.sort();
}

export function loadRulesFromDir(dir: string): LoadResult {
  const rules: AtrRule[] = [];
  const skipped: SkippedRule[] = [];
  for (const file of listRuleFiles(dir)) {
    const { rule, error } = parseRule(readFileSync(file, 'utf8'), file);
    if (rule) rules.push(rule);
    else skipped.push({ file, reason: error ?? 'unknown' });
  }
  return { rules, skipped };
}
