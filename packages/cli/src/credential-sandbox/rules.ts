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
export type KeyPath = (typeof KEY_PATHS)[number];
export const RETRY_RULE = 'Bash(dangerouslyDisableSandbox:true)';
export const RULE_IDS = [...KEY_PATHS, 'ask-retry', 'auto-allow', 'enabled'] as const;
export type RuleId = (typeof RULE_IDS)[number];
export interface SandboxChoices {
  readonly enable?: boolean;
  readonly extra?: boolean;
}
/** The real path behind a key path that is a link, as it is written beside it. */
export type LinkTargets = Readonly<Partial<Record<KeyPath, string>>>;

export interface OwnedRule {
  readonly id: RuleId;
  /** Depth of the first property the installation created. */
  readonly created: number;
  /** Only sandbox.enabled can replace a value, and only false. */
  readonly previous: false | null;
  /** On the record of a link's target: the path of that second deny entry. */
  readonly link?: string;
}

const FILES = ['sandbox', 'credentials', 'files'];
const ASK = ['permissions', 'ask'];
const ENABLED = ['sandbox', 'enabled'];
const AUTO_ALLOW = ['sandbox', 'autoAllowBashIfSandboxed'];
/** What a person can do when the file is one Stroq will not add sandbox settings to. */
const WAY_OUT =
  ' Nothing was changed. To install the hooks without the sandbox settings, run stroq init --agent claude-code --user --hooks-only.';

interface Spec {
  readonly path: string[];
  readonly value: JsonValue;
  readonly append: boolean;
}

function rule(id: RuleId, link?: string): Spec {
  switch (id) {
    case 'enabled':
      return { path: ENABLED, value: true, append: false };
    case 'auto-allow':
      return { path: AUTO_ALLOW, value: false, append: false };
    case 'ask-retry':
      return { path: ASK, value: RETRY_RULE, append: true };
    default:
      return { path: FILES, value: { path: link ?? id, mode: 'deny' }, append: true };
  }
}

function firstMissing(doc: JsonObject, path: string[]): number {
  let current: JsonValue = doc;
  for (const [index, key] of path.entries()) {
    if (!isObject(current))
      throw new Error(
        'Cannot edit Claude Code settings. Expected an object at ' +
          path.slice(0, index).join('.') +
          '.' +
          WAY_OUT,
      );
    if (!Object.hasOwn(current, key)) return index;
    current = current[key]!;
  }
  return path.length;
}

const isKeyFile = (e: JsonValue): boolean =>
  isObject(e) && typeof e.path === 'string' && (e.mode === 'deny' || e.mode === 'mask');

/** The document with the entry added to its list, or null when the list has it already. */
function appended(doc: JsonObject, spec: Spec, keyFile: boolean): JsonObject | null {
  const before = getAt(doc, spec.path);
  const at = spec.path.join('.');
  if (before !== undefined && !isArray(before))
    throw new Error('Expected an array in Claude Code settings at ' + at + '.' + WAY_OUT);
  const entries = before ?? [];
  if (entries.some((e) => (keyFile ? !isKeyFile(e) : typeof e !== 'string')))
    throw new Error('Unrecognized entry in Claude Code settings at ' + at + '.' + WAY_OUT);
  const path = keyFile && isObject(spec.value) ? spec.value.path : undefined;
  const there = entries.some(
    (e) => deepEqual(e, spec.value) || (path !== undefined && isObject(e) && e.path === path),
  );
  return there ? null : setAt(doc, spec.path, [...entries, spec.value]);
}

/** The document with the boolean set, or null when it is left as it is. */
function assigned(doc: JsonObject, spec: Spec, keepAny: boolean): JsonObject | null {
  const before = getAt(doc, spec.path);
  if (before !== undefined && typeof before !== 'boolean')
    throw new Error(
      'Expected a boolean in Claude Code settings at ' + spec.path.join('.') + '.' + WAY_OUT,
    );
  if (before === spec.value || (keepAny && before !== undefined)) return null;
  return setAt(doc, spec.path, spec.value);
}

const sameRule = (a: Pick<OwnedRule, 'id' | 'link'>, b: Pick<OwnedRule, 'id' | 'link'>): boolean =>
  a.id === b.id && a.link === b.link;

/** `owned` with the record of what was just written; a `false` that was replaced again is kept. */
function recorded(owned: readonly OwnedRule[], next: OwnedRule): OwnedRule[] {
  if (!owned.some((entry) => sameRule(entry, next))) return [...owned, next];
  if (next.previous === null) return [...owned];
  return owned.map((entry) =>
    sameRule(entry, next) ? { ...entry, previous: next.previous } : entry,
  );
}

function steps(
  input: JsonObject,
  prior: readonly OwnedRule[],
  choices: SandboxChoices,
  links: LinkTargets,
): Pick<OwnedRule, 'id' | 'link'>[] {
  const paths: KeyPath[] = [...BASE_PATHS, ...(choices.extra ? EXTRA_PATHS : [])];
  const out: Pick<OwnedRule, 'id' | 'link'>[] = paths.flatMap((id) => {
    const link = links[id];
    return link === undefined ? [{ id }] : [{ id }, { id, link }];
  });
  if (!choices.enable) return out;
  // A sandbox the user turned on keeps the approval setting the user has, set or not.
  const usersOwn = getAt(input, ENABLED) === true && !prior.some((r) => r.id === 'enabled');
  return [
    ...out,
    { id: 'ask-retry' },
    ...(usersOwn ? [] : [{ id: 'auto-allow' as const }]),
    { id: 'enabled' },
  ];
}

export interface Added {
  readonly doc: JsonObject;
  /** Every rule Stroq has a record of, the ones from before included. */
  readonly owned: OwnedRule[];
  /** What this call wrote. */
  readonly added: OwnedRule[];
}

export function addRules(
  input: JsonObject,
  prior: readonly OwnedRule[],
  choices: SandboxChoices,
  links: LinkTargets = {},
): Added {
  let doc = input;
  let owned = [...prior];
  const added: OwnedRule[] = [];
  for (const { id, link } of steps(input, prior, choices, links)) {
    const spec = rule(id, link);
    const created = firstMissing(doc, spec.path);
    const before = getAt(doc, spec.path);
    const next = spec.append
      ? appended(doc, spec, id !== 'ask-retry')
      : assigned(doc, spec, id === 'auto-allow');
    if (next === null) continue;
    doc = next;
    const record: OwnedRule = {
      id,
      created,
      previous: id === 'enabled' && before === false ? false : null,
      ...(link === undefined ? {} : { link }),
    };
    owned = recorded(owned, record);
    added.push(record);
  }
  return { doc, owned, added };
}

/** The document without the value one record names, where it is still what Stroq wrote. */
function withoutRule(doc: JsonObject, { id, previous, link }: OwnedRule): JsonObject {
  const { path, value, append } = rule(id, link);
  const current = getAt(doc, path);
  if (!append) {
    if (current !== value) return doc;
    return previous === null ? removeAt(doc, path) : setAt(doc, path, previous);
  }
  if (!isArray(current)) return doc;
  const index = current.findIndex((e) => deepEqual(e, value));
  if (index < 0) return doc;
  return setAt(
    doc,
    path,
    current.filter((_, i) => i !== index),
  );
}

/** The document without the containers one record made, where they are empty now. */
function withoutEmpty(doc: JsonObject, { id, created, link }: OwnedRule): JsonObject {
  const { path } = rule(id, link);
  let out = doc;
  for (let depth = path.length; depth > created; depth--) {
    const prefix = path.slice(0, depth);
    const rest = getAt(out, prefix);
    if (rest === undefined) continue;
    if (!isEmptyContainer(rest)) break;
    out = removeAt(out, prefix);
  }
  return out;
}

export function removeRules(input: JsonObject, owned: readonly OwnedRule[]): JsonObject {
  const newestFirst = [...owned].reverse();
  const emptied = newestFirst.reduce(withoutRule, input);
  // After every value is out: an entry taken out by hand must not keep the container Stroq made for it.
  return newestFirst.reduce(withoutEmpty, emptied);
}

/** What is in a settings file that matches what `stroq init` can write, whoever wrote it. */
export interface KnownEntries {
  readonly paths: readonly string[];
  readonly ask: boolean;
  readonly autoAllow: boolean;
  readonly enabled: boolean;
}

export function knownEntries(doc: JsonObject, links: LinkTargets = {}): KnownEntries {
  const files = getAt(doc, FILES);
  const ask = getAt(doc, ASK);
  const listed = (path: string): boolean =>
    isArray(files) && files.some((e) => deepEqual(e, { path, mode: 'deny' }));
  const paths = KEY_PATHS.flatMap((id) => {
    const link = links[id];
    return [id, ...(link === undefined ? [] : [link])].filter(listed);
  });
  const asks = isArray(ask) && ask.includes(RETRY_RULE);
  // The two booleans alone say nothing about Stroq: a person who turns the sandbox on writes the same.
  const told = paths.length > 0 || asks;
  return {
    paths,
    ask: asks,
    autoAllow: told && getAt(doc, AUTO_ALLOW) === false,
    enabled: told && getAt(doc, ENABLED) === true,
  };
}

export const hasKnownEntries = (known: KnownEntries): boolean =>
  known.paths.length > 0 || known.ask;
