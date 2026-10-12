import { PolicySchema, readRegularFile, type Policy } from '@stroq/core';
import { schemaFaults, type SchemaFault } from '../install/schema-fault.js';
import { unknownFieldPaths } from './unknown-fields.js';
import { readYaml, type YamlFault } from './yaml.js';

/**
 * The most a policy file may be. A real one is a few kilobytes (the default policy is about eight);
 * the bound is there so that a path that is not a policy, or a file somebody built to be slow, cannot
 * take the command down. Nothing the hook is given is cut at this size, so a policy over it is one
 * the hook would read and this refuses: the message says so.
 */
export const MAX_POLICY_BYTES = 1024 * 1024;

export type Unreadable = 'missing' | 'not-a-file' | 'too-large' | 'unreadable';

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

const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']);
const NOT_A_FILE_CODES = new Set(['EISDIR']);

function unreadableBecause(err: unknown): Unreadable {
  const code = (err as NodeJS.ErrnoException | undefined)?.code ?? '';
  if (MISSING_CODES.has(code)) return 'missing';
  if (NOT_A_FILE_CODES.has(code)) return 'not-a-file';
  return 'unreadable';
}

/** The text of the file, or why there is none. One handle is opened and checked, then read. */
function textOf(path: string): { text: string } | { why: Unreadable } {
  try {
    const read = readRegularFile(path, MAX_POLICY_BYTES);
    if (read.kind === 'text') return { text: read.text };
    return { why: read.kind === 'too-large' ? 'too-large' : 'not-a-file' };
  } catch (err) {
    return { why: unreadableBecause(err) };
  }
}

/**
 * A policy file as the hook loads it (the same YAML reading, the same schema, the same defaults), with
 * every way it can fail told apart and none of them quoting the file: no command is run and nothing
 * but this file is opened.
 */
export function readPolicyFile(path: string): PolicyRead {
  const file = textOf(path);
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
