import { closed, count, hash } from './local-guards';
import {
  validateCodexNetworkGuardBinding,
  validateCodexNetworkGuardCapture,
} from './codex-network-guard';
import {
  CODEX_PATH_GUARD_PRESETS,
  validateCodexPathGuardBinding,
  validateCodexPathGuardCapture,
} from './codex-path-guard';
export const exact = (v: unknown, k: string[]): v is Record<string, any> =>
  closed(v, k) && Reflect.ownKeys(v).length === k.length;
export const privatePath = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 4096 &&
  v.startsWith('/') &&
  !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(v) &&
  !v.split('/').some((p) => p === '.' || p === '..') &&
  !v.includes('//') &&
  (v === '/' || !v.endsWith('/'));
export const privateName = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 2048 &&
  !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(v);
export const privateRoot = (v: unknown) =>
  exact(v, ['path', 'dev', 'ino', 'uid', 'mode']) &&
  privatePath(v.path) &&
  ['dev', 'ino', 'uid', 'mode'].every((k) => Number.isSafeInteger(v[k]) && v[k] >= 0);
export const privatePin = (v: unknown, max = 256 * 1024) =>
  exact(v, ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']) &&
  Object.values(v).every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0) &&
  v.nlink === 1 &&
  count(v.size, max);
export const privateBytes = (v: unknown): v is Uint8Array =>
  v instanceof Uint8Array && v.byteLength <= 256 * 1024;
export const samePrivateBytes = (a: Uint8Array | null, b: Uint8Array | null) =>
  a === null
    ? b === null
    : b !== null && a.byteLength === b.byteLength && a.every((n, i) => n === b[i]);
export const privateSnapshot = (v: unknown) =>
  exact(v, ['bytes', 'sha256', 'mode', 'file', 'directories']) &&
  (v.sha256 === 'absent'
    ? v.bytes === null && v.file === null
    : privateBytes(v.bytes) &&
      hash(v.sha256) &&
      privatePin(v.file) &&
      v.file.size === v.bytes.byteLength) &&
  count(v.mode, 511) &&
  Array.isArray(v.directories) &&
  v.directories.length > 0 &&
  v.directories.length <= 128 &&
  v.directories.every(privateRoot);
export const privateContext = (v: unknown) =>
  exact(v, ['id', 'user', 'target', 'rootBinding']) &&
  typeof v.id === 'string' &&
  /^codex-context-[a-f0-9]{64}$/.test(v.id) &&
  privateRoot(v.user) &&
  privatePath(v.target) &&
  v.target.startsWith(v.user.path + '/') &&
  v.target.endsWith('/config.toml') &&
  hash(v.rootBinding);
export const samePrivate = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const privateNative = (v: unknown) =>
  exact(v, ['path', 'sha256', 'file', 'version', 'platform', 'parents']) &&
  privatePath(v.path) &&
  hash(v.sha256) &&
  privatePin(v.file, 512 * 1024 * 1024) &&
  v.platform === 'darwin' &&
  privateName(v.version) &&
  Array.isArray(v.parents) &&
  v.parents.length > 0 &&
  v.parents.length <= 128 &&
  v.parents.every(privateRoot);
export const privateSources = (v: unknown) =>
  Array.isArray(v) &&
  v.length <= 64 &&
  v.every(
    (s) =>
      exact(s, ['id', 'scope', 'path', 'root', 'snapshot']) &&
      typeof s.id === 'string' &&
      /^config-source-[a-f0-9]{24}$/.test(s.id) &&
      ['user', 'system', 'project', 'managed'].includes(s.scope) &&
      privatePath(s.path) &&
      privateRoot(s.root) &&
      privateSnapshot(s.snapshot),
  ) &&
  v.reduce((n, s) => n + (s.snapshot.bytes?.byteLength ?? 0), 0) <= 8 * 1024 * 1024;
export function privateNetworkCapture(v: unknown) {
  return (
    exact(v, [
      'public',
      'context',
      'sources',
      'native',
      'binding',
      'kind',
      'parentProfile',
      'before',
    ]) &&
    validateCodexNetworkGuardCapture(v.public) &&
    privateContext(v.context) &&
    privateSources(v.sources) &&
    privateNative(v.native) &&
    validateCodexNetworkGuardBinding(v.binding) &&
    v.binding.controlContextId === v.context.id &&
    v.binding.nativeBinarySha256 === v.native.sha256 &&
    samePrivate(v.binding, v.public.binding) &&
    privateSnapshot(v.before) &&
    [
      null,
      'profile-network-off',
      'profile-child',
      'legacy-network-off',
      'legacy-enable-workspace',
    ].includes(v.kind) &&
    (v.parentProfile === null || privateName(v.parentProfile))
  );
}
const targetSuffixes: Record<string, string> = {
  'aws-credentials': '.aws/credentials',
  'ssh-ed25519': '.ssh/id_ed25519',
  'ssh-rsa': '.ssh/id_rsa',
  npmrc: '.npmrc',
  netrc: '.netrc',
  pgpass: '.pgpass',
  'git-credentials': '.git-credentials',
};
export const privateTargetPath = (userPath: string, id: string) =>
  targetSuffixes[id] === undefined ? null : userPath + '/' + targetSuffixes[id];
export function privateTargets(v: unknown, userPath: string) {
  return (
    exact(v, ['targets', 'sha256']) &&
    hash(v.sha256) &&
    Array.isArray(v.targets) &&
    v.targets.length === CODEX_PATH_GUARD_PRESETS.length &&
    v.targets.every(
      (t: unknown, i: number) =>
        exact(t, ['id', 'path', 'status', 'directories', 'file']) &&
        t.id === CODEX_PATH_GUARD_PRESETS[i] &&
        t.path === privateTargetPath(userPath, t.id) &&
        ['regular', 'absent', 'unsafe', 'unavailable'].includes(t.status) &&
        Array.isArray(t.directories) &&
        t.directories.length <= 128 &&
        t.directories.every(privateRoot) &&
        (t.status === 'regular'
          ? privatePin(t.file, Number.MAX_SAFE_INTEGER) && t.directories.length > 0
          : t.file === null) &&
        (t.status !== 'absent' || t.directories.length > 0) &&
        (!['unsafe', 'unavailable'].includes(t.status) || t.directories.length === 0),
    )
  );
}
export function privatePathCapture(v: unknown) {
  if (
    !exact(v, [
      'public',
      'context',
      'before',
      'sources',
      'native',
      'binding',
      'profileName',
      'targets',
      'base',
      'dependencySha256',
    ]) ||
    !validateCodexPathGuardCapture(v.public) ||
    !privateContext(v.context) ||
    !privateSnapshot(v.before) ||
    !privateSources(v.sources) ||
    !privateNative(v.native) ||
    !validateCodexPathGuardBinding(v.binding) ||
    !samePrivate(v.public.binding, v.binding) ||
    v.binding.controlContextId !== v.context.id ||
    v.binding.nativeBinarySha256 !== v.native.sha256 ||
    !(v.profileName === null || (privateName(v.profileName) && v.profileName !== 'filesystem')) ||
    !privateTargets(v.targets, v.context.user.path) ||
    v.targets.sha256 !== v.binding.targetMetadataSha256 ||
    !privateNetworkCapture(v.base) ||
    !hash(v.dependencySha256)
  )
    return false;
  return (
    v.public.presets.every(
      (p: { target: string }, i: number) => p.target === v.targets.targets[i].status,
    ) &&
    samePrivate(v.base.context, v.context) &&
    samePrivate(v.base.native, v.native) &&
    samePrivate(v.base.sources, v.sources) &&
    v.base.before.sha256 === v.before.sha256 &&
    samePrivateBytes(v.base.before.bytes, v.before.bytes) &&
    v.binding.configSha256 === (v.before.sha256 === 'absent' ? null : v.before.sha256) &&
    v.base.binding.runtimeSha256 === v.binding.runtimeSha256 &&
    v.base.binding.sourceGraphSha256 === v.binding.sourceGraphSha256
  );
}
