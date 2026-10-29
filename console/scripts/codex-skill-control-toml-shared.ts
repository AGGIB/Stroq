import { parse } from 'smol-toml';
import { isDeepStrictEqual } from 'node:util';
import { basename, isAbsolute, resolve } from 'node:path';
import { indexCodexSkillToml } from './codex-skill-control-toml-lex.ts';
export const CODEX_SKILL_TOML_BYTES = 256 * 1024;
export const skillTomlError = (code: 'invalid' | 'limit' | 'conflict'): never => {
  throw Error('codex-skill-control-' + code);
};
export const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const semantic = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(semantic)
    : plain(value)
      ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, semantic(child)]))
      : value;
export const same = (a: unknown, b: unknown) => isDeepStrictEqual(semantic(a), semantic(b));
export const validOperation = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
export const safeText = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.length <= max &&
  value.length > 0 &&
  !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value);
export function assertSkillDocumentPath(value: unknown): asserts value is string {
  if (
    !safeText(value, 4096) ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    basename(value) !== 'SKILL.md'
  )
    skillTomlError('invalid');
}
export function readSkillControlToml(bytes: Uint8Array | null) {
  if (bytes !== null && !(bytes instanceof Uint8Array)) return skillTomlError('invalid');
  if (bytes !== null && bytes.byteLength > CODEX_SKILL_TOML_BYTES) return skillTomlError('limit');
  let text: string, document: Record<string, unknown>;
  try {
    text =
      bytes === null ? '' : new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes);
    document = parse(text.replace(/^\uFEFF/, ''), {
      maxDepth: 32,
      unsafeKeyBehaviour: 'throw',
      integersAsBigInt: true,
    });
  } catch {
    return skillTomlError('invalid');
  }
  let nodes = 0;
  const visit = (value: unknown, depth = 0): void => {
    if (++nodes > 16384 || depth > 32) skillTomlError('limit');
    if (Array.isArray(value)) for (const child of value) visit(child, depth + 1);
    else if (plain(value)) for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(document);
  const skills = document.skills;
  if (skills !== undefined && !plain(skills)) return skillTomlError('invalid');
  const rules = plain(skills) ? skills.config : undefined;
  if (rules !== undefined && !Array.isArray(rules)) return skillTomlError('invalid');
  if (Array.isArray(rules) && rules.length > 512) return skillTomlError('limit');
  for (const rule of (rules ?? []) as unknown[]) {
    if (
      !plain(rule) ||
      typeof rule.enabled !== 'boolean' ||
      (rule.path === undefined) === (rule.name === undefined)
    )
      return skillTomlError('invalid');
    if (rule.path !== undefined && !safeText(rule.path, 4096)) return skillTomlError('invalid');
    if (
      rule.name !== undefined &&
      (!safeText(rule.name, 2048) ||
        !rule.name.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, ''))
    )
      return skillTomlError('invalid');
  }
  return {
    text,
    document,
    rules: (rules ?? []) as Record<string, unknown>[],
    index: indexCodexSkillToml(text),
  };
}
export const markerFor = (id: string) => '# stroq-skill-control ' + id;
export function removeSkillTomlSpans(
  text: string,
  spans: { start: number; end: number }[],
): string {
  const ordered = [...spans].sort((a, b) => b.start - a.start);
  let last = text.length,
    result = text;
  for (const span of ordered) {
    if (
      !Number.isSafeInteger(span.start) ||
      !Number.isSafeInteger(span.end) ||
      span.start < 0 ||
      span.end < span.start ||
      span.end > last
    )
      skillTomlError('conflict');
    result = result.slice(0, span.start) + result.slice(span.end);
    last = span.start;
  }
  return result;
}
export function verifySkillTomlRestore(
  current: Record<string, unknown>,
  after: Record<string, unknown>,
  original: Record<string, unknown>,
  ownIndex: number,
): void {
  if (!plain(current.skills) || !Array.isArray(current.skills.config))
    return skillTomlError('conflict');
  const rules = current.skills.config.filter((_, index) => index !== ownIndex);
  const skills = { ...current.skills, config: rules } as Record<string, unknown>,
    expected = { ...current, skills } as Record<string, unknown>;
  if (plain(after.skills) && after.skills.config === undefined) {
    if (rules.length !== 0 || (plain(original.skills) && original.skills.config !== undefined))
      skillTomlError('conflict');
    delete skills.config;
  }
  if (after.skills === undefined) {
    if (
      rules.length !== 0 ||
      original.skills !== undefined ||
      Object.keys(current.skills).some((k) => k !== 'config')
    )
      skillTomlError('conflict');
    delete expected.skills;
  }
  if (!same(expected, after)) skillTomlError('conflict');
}
