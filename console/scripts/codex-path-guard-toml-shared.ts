import { isAbsolute, resolve } from 'node:path';
import { safeText } from './codex-skill-control-toml-shared.ts';
import { readNetworkToml, mutateNetworkToml, plain } from './codex-network-guard-toml-shared.ts';
export {
  plain,
  same,
  validOperation,
  findCodexSkillTomlValue,
  replaceValue,
  insertNetworkTomlLeaf,
  eolFor,
  separatorFor,
  inlineNetworkFieldOwner,
  ownerMarkerSpan,
  uniqueInsertionRemoval,
} from './codex-network-guard-toml-shared.ts';
export type { NetworkTomlMutation as PathTomlMutation } from './codex-network-guard-toml-shared.ts';
export function pathTomlError(code: 'invalid' | 'limit' | 'conflict' | 'already-denied'): never {
  throw Error('codex-path-guard-' + code);
}
export function pathTomlErrors<T>(
  action: () => T,
  fallback: 'invalid' | 'conflict' = 'invalid',
): T {
  try {
    return action();
  } catch (error) {
    const code = (error as Error)?.message;
    if (code?.startsWith('codex-path-guard-')) throw error;
    return pathTomlError(code?.endsWith('-limit') ? 'limit' : fallback);
  }
}
export const readPathToml = (bytes: Uint8Array | null) =>
  pathTomlErrors(() => readNetworkToml(bytes));
export const mutatePathToml = (text: string, changes: Parameters<typeof mutateNetworkToml>[1]) =>
  pathTomlErrors(() => mutateNetworkToml(text, changes), 'conflict');
export const pathMarker = (id: string) => '# stroq-path-guard ' + id;
export function assertTargetPath(value: unknown): asserts value is string {
  if (
    !safeText(value, 4096) ||
    Buffer.byteLength(value) > 4096 ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value === '/' ||
    /[\\*?\[\]{}]/.test(value)
  )
    pathTomlError('invalid');
}
const access = (value: unknown): value is string =>
  typeof value === 'string' && ['read', 'write', 'deny'].includes(value);
const ancestor = (parent: string, child: string) =>
  parent !== child && (parent === '/' || child.startsWith(parent + '/'));
export function pathFilesystem(value: unknown, target: string, prior?: Record<string, unknown>) {
  if (value !== undefined && !plain(value)) return pathTomlError('invalid');
  const filesystem = plain(value) ? value : {};
  let rules = 0,
    broaderDenied = false;
  for (const [key, permission] of Object.entries(filesystem)) {
    if (!safeText(key, 4096)) return pathTomlError('invalid');
    if (key === 'glob_scan_max_depth') {
      if (
        !['number', 'bigint'].includes(typeof permission) ||
        !Number.isSafeInteger(Number(permission)) ||
        Number(permission) < 1 ||
        Number(permission) > 64
      )
        pathTomlError('invalid');
      continue;
    }
    if (access(permission)) rules++;
    else if (
      plain(permission) &&
      Object.entries(permission).every(([part, p]) => safeText(part, 4096) && access(p))
    )
      rules += Object.keys(permission).length;
    else pathTomlError(key === target ? 'conflict' : 'invalid');
    if (rules > 512) pathTomlError('limit');
    if (key === target && plain(permission)) pathTomlError('conflict');
    // Effective scoped/glob/relative aliases are caller-owned. Literal relationships are exact.
    if (!key.startsWith('/') || /[\\*?\[\]{}]/.test(key)) continue;
    const normalized = resolve(key);
    if (normalized === target && key !== target) pathTomlError('conflict');
    if (ancestor(target, normalized) && (permission === 'read' || permission === 'write'))
      pathTomlError('conflict');
    if (ancestor(normalized, target) && permission === 'deny') {
      broaderDenied = true;
      if (prior && prior[key] !== 'deny') pathTomlError('conflict');
    }
  }
  return { filesystem, rules, broaderDenied };
}
export const valueAt = (document: Record<string, unknown>, path: string[]): unknown =>
  path.reduce<unknown>((value, key) => (plain(value) ? value[key] : undefined), document);
