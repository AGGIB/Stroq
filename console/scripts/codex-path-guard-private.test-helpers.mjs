import { createHash } from 'node:crypto';
import { after } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
const loader = await mkdtemp(join(tmpdir(), 'stroq-path-private-loader-'));
after(() => rm(loader, { recursive: true, force: true }));
const tsconfig = join(loader, 'tsconfig.json');
await writeFile(
  tsconfig,
  JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
  }),
);
const load = (p) => tsImport(p, { parentURL: import.meta.url, tsconfig });
export const privateSchema = await load('../lib/codex-path-guard-private.ts');
const planner = await load('./codex-path-guard-toml.ts');
export const publicSchema = await load('../lib/codex-path-guard.ts');
const hash = 'a'.repeat(64),
  uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (b) => createHash('sha256').update(b).digest('hex');
const root = { path: '/fixture/user', dev: 1, ino: 2, uid: 501, mode: 0o40700 },
  pin = { dev: 1, ino: 3, uid: 501, mode: 0o100600, nlink: 1, size: 0, mtimeMs: 1, ctimeMs: 1 };
const suffixes = [
  '.aws/credentials',
  '.ssh/id_ed25519',
  '.ssh/id_rsa',
  '.npmrc',
  '.netrc',
  '.pgpass',
  '.git-credentials',
];
export function createPathGuardPrivatePlanFixture({
  operation = 'guard',
  presetId = 'aws-credentials',
  recordId = uuid(1),
  operationId = uuid(2),
  previewId = uuid(3),
  now = Date.parse('2026-10-27T00:00:00.000Z'),
} = {}) {
  const context = {
    id: 'codex-context-' + hash,
    user: { ...root },
    target: root.path + '/.codex/config.toml',
    rootBinding: hash,
  };
  const initial = Buffer.from(
    'default_permissions="source"\n[permissions.source]\nextends=":workspace"\nnetwork={enabled=false}\n',
  );
  const targetPath =
    root.path + '/' + suffixes[publicSchema.CODEX_PATH_GUARD_PRESETS.indexOf(presetId)];
  const planned = planner.planCodexPathGuard({ bytes: initial, operationId: recordId, targetPath });
  const beforeBytes = operation === 'guard' ? initial : Buffer.from(planned.bytes),
    before = {
      bytes: beforeBytes,
      sha256: digest(beforeBytes),
      mode: 0o600,
      file: { ...pin, size: beforeBytes.length },
      directories: [{ ...root }],
    };
  const binding = {
    controlContextId: context.id,
    captureSha256: hash,
    configSha256: before.sha256,
    runtimeSha256: hash,
    nativeBinarySha256: hash,
    sourceGraphSha256: hash,
    targetMetadataSha256: hash,
  };
  const source = {
    id: 'config-source-' + hash.slice(0, 24),
    scope: 'user',
    path: context.target,
    root: { ...root },
    snapshot: structuredClone(before),
  };
  const native = {
    path: '/fixture/native',
    sha256: hash,
    file: { ...pin, size: 10 },
    version: 'codex-cli 0.164.0-alpha.11.1',
    platform: 'darwin',
    parents: [{ ...root }],
  };
  const compatibility = {
      status: 'supported',
      version: native.version,
      platform: 'darwin',
      binarySha256: hash,
    },
    baseline = { kind: 'profile', profile: 'custom', network: 'off' };
  const networkBinding = { ...binding };
  delete networkBinding.targetMetadataSha256;
  const base = {
    public: {
      schema: 'stroq-codex-network-capture/1',
      capturedAt: new Date(now).toISOString(),
      binding: networkBinding,
      compatibility,
      baseline,
      actionKind: null,
      filesystemEffect: 'unchanged',
      canGuard: false,
      canCheck: false,
      reason: 'codex-network-already-off',
      layers: [],
      gaps: [],
    },
    context: structuredClone(context),
    sources: [source],
    native: structuredClone(native),
    binding: networkBinding,
    kind: null,
    parentProfile: null,
    before: structuredClone(before),
  };
  const targets = {
    targets: publicSchema.CODEX_PATH_GUARD_PRESETS.map((id, i) => ({
      id,
      path: root.path + '/' + suffixes[i],
      status: 'absent',
      directories: [{ ...root }],
      file: null,
    })),
    sha256: hash,
  };
  const capture = {
    public: {
      schema: 'stroq-codex-path-capture/1',
      capturedAt: new Date(now).toISOString(),
      binding,
      compatibility,
      baseline,
      actionKind: 'profile-path-deny',
      reason: null,
      presets: publicSchema.CODEX_PATH_GUARD_PRESETS.map((id) => ({
        id,
        target: 'absent',
        declaration: 'read',
        canGuard: true,
        reason: null,
      })),
      gaps: [],
    },
    context: structuredClone(context),
    before: structuredClone(before),
    sources: [structuredClone(source)],
    native: structuredClone(native),
    binding: structuredClone(binding),
    profileName: 'source',
    targets,
    base,
    dependencySha256: hash,
  };
  const candidate =
    operation === 'guard'
      ? Buffer.from(planned.bytes)
      : planner.restoreCodexPathGuard({ bytes: beforeBytes, owned: planned.owned });
  const preview = {
    schema: 'stroq-codex-path-preview/1',
    id: previewId,
    operationId,
    controlContextId: context.id,
    operation,
    kind: 'profile-path-deny',
    presetId,
    recordId,
    recordRevision: operation === 'guard' ? null : hash,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 120000).toISOString(),
    binding: operation === 'guard' ? structuredClone(binding) : null,
    beforeSha256: before.sha256,
    afterSha256: digest(candidate),
    pathEffect: operation === 'guard' ? 'deny-read-write' : 'prior-settings',
    filesystemEffect: operation === 'guard' ? 'deny-exact-path' : 'prior-settings',
    networkEffect: 'preserved',
    sharedUserConfig: true,
    retainsConfigurationCopies: true,
    formattingPreserved: true,
    hostEnforcement: false,
  };
  const request =
    operation === 'guard'
      ? { operation, controlContextId: context.id, captureSha256: hash, presetId }
      : { operation, controlContextId: context.id, recordId, recordRevision: hash };
  return {
    schema: 'stroq-codex-path-private-plan/1',
    preview,
    request,
    context,
    before,
    candidate,
    owned: structuredClone(planned.owned),
    capture,
  };
}
