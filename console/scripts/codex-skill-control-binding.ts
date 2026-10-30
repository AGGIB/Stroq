import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runtimeDigest } from './runtime-digest.mjs';
import { rootIdentity, snapshotFile } from './agent-setup-files.mjs';
import { captureCodexSkillSourceContext } from './codex-skill-source-context.ts';
import type {
  CodexSkillControlPreview,
  CodexSkillControlSelection,
  CodexSkillControlRestoreSelection,
} from '../lib/codex-skill-controls.ts';
import type { SkillLocation } from '../lib/skill-location.ts';
import type { CodexSkillDisableOwnership } from './codex-skill-control-toml.ts';
export const CONFIG_BYTES = 256 * 1024,
  RECORDS = 32,
  STORE_BYTES = 17 * 1024 * 1024,
  MANIFEST_BYTES = 16384;
export const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export const controlHash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
export const nullableHash = (v: Buffer | null) => (v === null ? null : controlHash(v));
export function fail(code: string): never {
  throw new Error(code);
}
export const owned = (v: { uid: number }) =>
  typeof process.getuid !== 'function' || v.uid === process.getuid();
export type Snapshot = Awaited<ReturnType<typeof snapshotFile>>;
export type Root = Awaited<ReturnType<typeof rootIdentity>>;
export type Pin = NonNullable<Snapshot['file']>;
export type PublishedPin = Omit<Pin, 'ctimeMs'>;
export type ParentPin = Pick<Root, 'dev' | 'ino' | 'uid' | 'mode'>;
export const controlParents = (snapshot: { directories: Root[] }): ParentPin[] =>
  snapshot.directories.map(({ dev, ino, uid, mode }) => ({ dev, ino, uid, mode }));
export const publishedPin = ({ ctimeMs: _ctime, ...v }: Pin): PublishedPin => v;
export const same = isDeepStrictEqual;
export type ControlOptions = {
  project: string;
  userHome: string;
  codexEnvironment?: { CODEX_HOME?: string };
  deadline: number;
  runtimeSha256: string;
  runtimePaths?: { cli: string; package: string; manifest?: string; manifestRoot?: string };
};
export type ControlContext = { id: string; user: Root; target: string; rootBinding: string };
export type ControlManifest = {
  schema: 'stroq-codex-skill-control-record/1';
  id: string;
  operationId: string;
  controlContextId: string;
  rootBinding: string;
  target: string;
  documentPath: string;
  nativeName: string;
  name: string;
  location: SkillLocation;
  createdAt: string;
  updatedAt: string;
  phase: 'prepared' | 'disabled' | 'restoring' | 'restored';
  originalSha256: string | null;
  candidateSha256: string;
  mode: number;
  beforeBytes: number;
  candidateBytes: number;
  sourceId: string;
  candidateId: string;
  entrypointSha256: string;
  runtimeSha256: string;
  staged: PublishedPin | null;
  parents: ParentPin[];
  publication: Pin | null;
  restoreSha256: string | null;
  restoreStaged: PublishedPin | null;
  restorePublication: Pin | null;
  removal: {
    directory: string;
    directoryPin: Root | null;
    original: Pin;
    moved: Pin | null;
  } | null;
};
export type ControlRecord = {
  manifest: ControlManifest;
  revision: string;
  directory: string;
  path: string;
  before: Buffer | null;
  candidate: Buffer;
  owned: CodexSkillDisableOwnership;
};
export type { ControlPrivatePlan } from '../lib/codex-skill-controls-private.ts';
export async function controlContext(options: ControlOptions): Promise<ControlContext> {
  const ctx = await captureCodexSkillSourceContext(options);
  if (
    !ctx.controlContextId ||
    !ctx.profile.path ||
    !['ready', 'missing'].includes(ctx.configuration.status)
  )
    fail('codex-control-unsupported');
  const user = ctx.userHome;
  if (!owned(user) || (user.mode & 0o022) !== 0) fail('codex-control-unavailable');
  return {
    id: ctx.controlContextId,
    user,
    target: join(ctx.profile.path, 'config.toml'),
    rootBinding: controlHash(JSON.stringify(user)),
  };
}
export function checkDeadline(options: ControlOptions) {
  if (Date.now() >= options.deadline) fail('codex-control-stale');
}
export async function assertRuntime(options: ControlOptions) {
  checkDeadline(options);
  if (!options.runtimePaths) fail('codex-control-runtime-changed');
  try {
    if ((await runtimeDigest(options.runtimePaths)) !== options.runtimeSha256)
      fail('codex-control-runtime-changed');
  } catch {
    fail('codex-control-runtime-changed');
  }
  checkDeadline(options);
}
export async function assertContext(options: ControlOptions, context: ControlContext) {
  checkDeadline(options);
  const current = await controlContext(options);
  if (!same(current, context)) fail('codex-control-stale');
}
export async function sourceSnapshot(context: ControlContext) {
  const result: Snapshot = await snapshotFile(context.user, context.target, CONFIG_BYTES);
  if (
    result.directories.some(
      (d) => !owned(d) || (d.mode & 0o022) !== 0 || (d.mode & 0o300) !== 0o300,
    ) ||
    (result.file &&
      (!owned(result.file) || (result.file.mode & 0o022) !== 0 || (result.file.mode & 0o200) === 0))
  )
    fail('codex-control-unsupported');
  return result;
}
