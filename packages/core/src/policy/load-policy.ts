import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { PolicySchema, type Policy } from './policy-types.js';

export function parsePolicy(yamlText: string): Policy {
  return PolicySchema.parse(parse(yamlText));
}

export function loadPolicyFile(path: string): Policy {
  return parsePolicy(readFileSync(path, 'utf8'));
}
