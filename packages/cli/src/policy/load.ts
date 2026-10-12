import { PolicySchema, type Policy } from '@stroq/core';
import { schemaFaults, type SchemaFault } from '../install/schema-fault.js';
import { readBoundedText, type Unreadable } from './read-text.js';
import { unknownFieldPaths } from './unknown-fields.js';
import { readYaml, type YamlFault } from './yaml.js';

/**
 * The most a policy file may be. A real one is a few kilobytes (the default policy is about eight);
 * the bound is there so that a path that is not a policy, or a file somebody built to be slow, cannot
 * take the command down. Nothing the hook is given is cut at this size, so a policy over it is one
 * the hook would read and this refuses: the message says so.
 */
export const MAX_POLICY_BYTES = 1024 * 1024;

export type { Unreadable };

export type PolicyRead =
  | { readonly ok: true; readonly policy: Policy; readonly unknownFields: readonly string[] }
  | { readonly ok: false; readonly problem: 'unreadable'; readonly why: Unreadable }
  | { readonly ok: false; readonly problem: 'yaml'; readonly fault: YamlFault }
  | {
      readonly ok: false;
      readonly problem: 'schema';
      readonly faults: readonly SchemaFault[];
      readonly unknownFields: readonly string[];
    };

/**
 * A policy file as the hook loads it (the same YAML reading, the same schema, the same defaults), with
 * every way it can fail told apart and none of them quoting the file: no command is run and nothing
 * but this file is opened.
 */
export function readPolicyFile(path: string): PolicyRead {
  const file = readBoundedText(path, MAX_POLICY_BYTES);
  if ('why' in file) return { ok: false, problem: 'unreadable', why: file.why };
  const yaml = readYaml(file.text);
  if (!yaml.ok) return { ok: false, problem: 'yaml', fault: yaml.fault };
  const unknownFields = unknownFieldPaths(yaml.value);
  const parsed = PolicySchema.safeParse(yaml.value);
  if (!parsed.success) {
    return { ok: false, problem: 'schema', faults: schemaFaults(parsed.error), unknownFields };
  }
  return { ok: true, policy: parsed.data, unknownFields };
}
