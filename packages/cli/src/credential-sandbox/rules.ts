import {
  deepEqual,
  getAt,
  isArray,
  isEmptyContainer,
  isObject,
  removeAt,
  setAt,
} from '../harden/json-doc.js';
import type { JsonObject, JsonValue } from '../harden/types.js';

export const BASE_PATHS = [
  '~/.ssh',
  '~/.config/gcloud',
  '~/.config/gh/hosts.yml',
  '~/.kube/config',
  '~/.docker/config.json',
  '~/.netrc',
  '~/.pgpass',
  '~/.git-credentials',
] as const;
export const EXTRA_PATHS = [
  '~/.aws/credentials',
  '~/.aws/sso/cache',
  '~/.aws/cli/cache',
  '~/.npmrc',
  '~/.gnupg',
] as const;
export const KEY_PATHS = [...BASE_PATHS, ...EXTRA_PATHS] as const;
export const RETRY_RULE = 'Bash(dangerouslyDisableSandbox:true)';
export const RULE_IDS = [...KEY_PATHS, 'ask-retry', 'auto-allow', 'enabled'] as const;
export type RuleId = (typeof RULE_IDS)[number];
export interface SandboxChoices {
  readonly enable?: boolean;
  readonly extra?: boolean;
}

export interface OwnedRule {
  readonly id: RuleId;
  /** Depth of the first property the installation created. */
  readonly created: number;
  /** Only sandbox.enabled can replace a value, and only false. */
  readonly previous: false | null;
}

function rule(id: RuleId): { path: string[]; value: JsonValue; append: boolean } {
  switch (id) {
    case 'enabled':
      return { path: ['sandbox', 'enabled'], value: true, append: false };
    case 'auto-allow':
      return { path: ['sandbox', 'autoAllowBashIfSandboxed'], value: false, append: false };
    case 'ask-retry':
      return { path: ['permissions', 'ask'], value: RETRY_RULE, append: true };
    default:
      return {
        path: ['sandbox', 'credentials', 'files'],
        value: { path: id, mode: 'deny' },
        append: true,
      };
  }
}

function firstMissing(doc: JsonObject, path: string[]): number {
  let current: JsonValue = doc;
  for (const [index, key] of path.entries()) {
    if (!isObject(current))
      throw new Error(
        'Cannot edit Claude Code settings. Expected an object at ' +
          path.slice(0, index).join('.') +
          '.',
      );
    if (!Object.hasOwn(current, key)) return index;
    current = current[key]!;
  }
  return path.length;
}

export function addRules(input: JsonObject, prior: readonly OwnedRule[], choices: SandboxChoices) {
  const ids: RuleId[] = [...BASE_PATHS];
  if (choices.extra) ids.push(...EXTRA_PATHS);
  if (choices.enable) ids.push('ask-retry', 'auto-allow', 'enabled');
  let doc = input;
  const owned = [...prior];
  for (const id of ids) {
    const { path, value, append } = rule(id);
    const created = firstMissing(doc, path);
    const before = getAt(doc, path);
    if (append) {
      if (before !== undefined && !isArray(before))
        throw new Error('Expected an array in Claude Code settings at ' + path.join('.') + '.');
      const entries = before ?? [];
      const keyFile = id !== 'ask-retry';
      if (
        entries.some((e) =>
          keyFile
            ? !isObject(e) || typeof e.path !== 'string' || (e.mode !== 'deny' && e.mode !== 'mask')
            : typeof e !== 'string',
        )
      )
        throw new Error('Unrecognized entry in Claude Code settings at ' + path.join('.') + '.');
      if (entries.some((e) => deepEqual(e, value) || (keyFile && isObject(e) && e.path === id)))
        continue;
      doc = setAt(doc, path, [...entries, value]);
    } else {
      if (before !== undefined && typeof before !== 'boolean')
        throw new Error('Expected a boolean in Claude Code settings at ' + path.join('.') + '.');
      if (before === value || (id === 'auto-allow' && before !== undefined)) continue;
      doc = setAt(doc, path, value);
    }
    if (!owned.some((entry) => entry.id === id))
      owned.push({ id, created, previous: id === 'enabled' && before === false ? false : null });
  }
  return { doc, owned };
}

export function removeRules(input: JsonObject, owned: readonly OwnedRule[]): JsonObject {
  let doc = input;
  for (const { id, created, previous } of [...owned].reverse()) {
    const { path, value, append } = rule(id);
    const current = getAt(doc, path);
    if (append) {
      if (!isArray(current)) continue;
      const index = current.findIndex((e) => deepEqual(e, value));
      if (index < 0) continue;
      doc = setAt(
        doc,
        path,
        current.filter((_, i) => i !== index),
      );
    } else {
      if (current !== value) continue;
      doc = previous === null ? removeAt(doc, path) : setAt(doc, path, previous);
    }
    for (let depth = path.length; depth > created; depth--) {
      const prefix = path.slice(0, depth);
      const rest = getAt(doc, prefix);
      if (rest !== undefined && !isEmptyContainer(rest)) break;
      doc = removeAt(doc, prefix);
    }
  }
  return doc;
}
