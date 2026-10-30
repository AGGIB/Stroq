import { closed, count, hash } from './local-guards';
import {
  validateCodexNetworkGuardBinding,
  type CodexNetworkGuardBinding,
} from './codex-network-guard';
import type { GuardPrivateNative } from './codex-network-guard-private';
import type {
  PrivateControlRoot as Root,
  PrivateControlPin as Pin,
} from './codex-skill-controls-private';
export type CodexNetworkCheckProfile = {
  extends?: string;
  filesystem?: Record<
    string,
    'read' | 'write' | 'deny' | number | Record<string, 'read' | 'write' | 'deny'>
  >;
  workspace_roots?: Record<string, boolean>;
  network?: Record<string, unknown>;
};
export type CodexNetworkCheckSourcePin = {
  id: string;
  scope: 'user' | 'system' | 'project' | 'managed';
  path: string;
  root: Root;
  sha256: string;
  file: Pin | null;
  directories: Root[];
};
export type CodexNetworkGuardCheckPreparation = {
  binding: CodexNetworkGuardBinding;
  kind: 'profile' | 'legacy-translated' | 'implicit-translated';
  profiles: Record<string, CodexNetworkCheckProfile>;
  selectedProfile: string;
  native: GuardPrivateNative;
  sourcePins: CodexNetworkCheckSourcePin[];
  networkOff: true;
  managedUnverified: boolean;
};
const exact = (v: unknown, k: string[]): v is Record<string, any> =>
  closed(v, k) && Reflect.ownKeys(v).length === k.length;
const name = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 4096 &&
  !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(v);
const plain = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && closed(v, Object.keys(v));
const path = (v: unknown) =>
  name(v) && v.startsWith('/') && !v.split('/').some((p) => p === '.' || p === '..');
const root = (v: unknown) =>
  exact(v, ['path', 'dev', 'ino', 'uid', 'mode']) &&
  path(v.path) &&
  ['dev', 'ino', 'uid', 'mode'].every((k) => Number.isSafeInteger(v[k]) && v[k] >= 0);
const pin = (v: unknown, max = 256 * 1024) =>
  exact(v, ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']) &&
  Object.values(v).every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0) &&
  v.nlink === 1 &&
  count(v.size, max);
const access = (v: unknown) => typeof v === 'string' && ['read', 'write', 'deny'].includes(v);
function profile(v: unknown): v is CodexNetworkCheckProfile {
  if (
    !closed(v, ['extends', 'filesystem', 'workspace_roots', 'network']) ||
    (v.extends !== undefined && !name(v.extends))
  )
    return false;
  if (
    v.workspace_roots !== undefined &&
    (!plain(v.workspace_roots) ||
      Object.keys(v.workspace_roots).length > 64 ||
      !Object.entries(v.workspace_roots).every(([k, b]) => name(k) && typeof b === 'boolean'))
  )
    return false;
  if (
    v.filesystem !== undefined &&
    (!plain(v.filesystem) ||
      Object.keys(v.filesystem).length > 1024 ||
      !Object.entries(v.filesystem).every(
        ([k, a]) =>
          name(k) &&
          (k === 'glob_scan_max_depth'
            ? count(a, 64) && a > 0
            : access(a) ||
              (plain(a) &&
                Object.keys(a).length <= 1024 &&
                Object.entries(a).every(([n, p]) => name(n) && access(p)))),
      ))
  )
    return false;
  if (v.network !== undefined) {
    const n = v.network;
    if (
      !closed(n, [
        'enabled',
        'domains',
        'unix_sockets',
        'enable_socks5',
        'enable_socks5_udp',
        'allow_local_binding',
      ])
    )
      return false;
    for (const k of ['enabled', 'enable_socks5', 'enable_socks5_udp', 'allow_local_binding'])
      if (n[k] !== undefined && typeof n[k] !== 'boolean') return false;
    for (const k of ['domains', 'unix_sockets'])
      if (
        n[k] !== undefined &&
        (!plain(n[k]) ||
          Object.keys(n[k]).length > 512 ||
          !Object.entries(n[k]).every(
            ([key, value]) => name(key) && (value === 'allow' || value === 'deny'),
          ))
      )
        return false;
  }
  return true;
}
export function validateCodexNetworkGuardCheckPreparation(
  v: unknown,
): v is CodexNetworkGuardCheckPreparation {
  if (
    !exact(v, [
      'binding',
      'kind',
      'profiles',
      'selectedProfile',
      'native',
      'sourcePins',
      'networkOff',
      'managedUnverified',
    ]) ||
    !validateCodexNetworkGuardBinding(v.binding) ||
    !['profile', 'legacy-translated', 'implicit-translated'].includes(v.kind) ||
    !plain(v.profiles) ||
    Object.keys(v.profiles).length > 16 ||
    !Object.entries(v.profiles).every(([k, p]) => name(k) && !k.startsWith(':') && profile(p)) ||
    !name(v.selectedProfile) ||
    !exact(v.native, ['path', 'sha256', 'file', 'version', 'platform', 'parents']) ||
    !path(v.native.path) ||
    v.native.sha256 !== v.binding.nativeBinarySha256 ||
    !pin(v.native.file, 512 * 1024 * 1024) ||
    !name(v.native.version) ||
    v.native.platform !== 'darwin' ||
    !Array.isArray(v.native.parents) ||
    v.native.parents.length < 1 ||
    v.native.parents.length > 128 ||
    !v.native.parents.every(root) ||
    !Array.isArray(v.sourcePins) ||
    v.sourcePins.length < 1 ||
    v.sourcePins.length > 64 ||
    !v.sourcePins.every(
      (s: unknown) =>
        exact(s, ['id', 'scope', 'path', 'root', 'sha256', 'file', 'directories']) &&
        typeof s.id === 'string' &&
        /^config-source-[a-f0-9]{24}$/.test(s.id) &&
        ['user', 'system', 'project', 'managed'].includes(s.scope) &&
        path(s.path) &&
        root(s.root) &&
        (s.sha256 === 'absent' ? s.file === null : hash(s.sha256) && pin(s.file)) &&
        Array.isArray(s.directories) &&
        s.directories.length > 0 &&
        s.directories.length <= 128 &&
        s.directories.every(root),
    ) ||
    v.networkOff !== true ||
    typeof v.managedUnverified !== 'boolean'
  )
    return false;
  const visited = new Set<string>();
  const off = (selected: string): boolean | null => {
    if (visited.has(selected) || visited.size > 16) return null;
    if (selected === ':workspace' || selected === ':read-only') return true;
    if (selected.startsWith(':')) return null;
    visited.add(selected);
    const p = v.profiles[selected];
    if (!p) return null;
    const parent = p.extends ? off(p.extends) : true;
    if (parent === null) return null;
    return p.network?.enabled === undefined ? parent : p.network.enabled === false;
  };
  const disabled = off(v.selectedProfile);
  return disabled === true && visited.size === Object.keys(v.profiles).length;
}
export function codexNetworkGuardCheckPreparationBytes(v: unknown) {
  return validateCodexNetworkGuardCheckPreparation(v) ? JSON.stringify(v).length * 3 : Infinity;
}
