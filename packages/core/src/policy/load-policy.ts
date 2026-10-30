import { readFileSync } from 'node:fs';
import { yaml } from '../util/yaml.js';
import { PolicySchema, type Policy } from './policy-types.js';

export function parsePolicy(yamlText: string): Policy {
  return PolicySchema.parse(yaml().parse(yamlText));
}

export function loadPolicyFile(path: string): Policy {
  return parsePolicy(readFileSync(path, 'utf8'));
}
