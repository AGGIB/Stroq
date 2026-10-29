import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import {
  controlContext,
  sourceSnapshot,
  assertContext,
  assertRuntime,
  controlParents,
  publishedPin,
  same,
  owned,
  CONFIG_BYTES,
  MANIFEST_BYTES,
  RECORDS,
  STORE_BYTES,
  UUID,
  controlHash,
  nullableHash,
  type ControlContext,
  type ControlOptions,
  type Root,
  type Snapshot,
  type Pin,
  type PublishedPin,
  type ParentPin,
} from './codex-skill-control-binding.ts';
import type {
  CodexNetworkGuardKind,
  CodexNetworkGuardBinding,
  CodexNetworkGuardCapture,
} from '../lib/codex-network-guard.ts';
import type { CodexNetworkGuardOwnership } from './codex-network-guard-toml.ts';
export {
  controlContext,
  sourceSnapshot,
  assertContext,
  assertRuntime,
  controlParents,
  publishedPin,
  same,
  owned,
  CONFIG_BYTES,
  MANIFEST_BYTES,
  RECORDS,
  STORE_BYTES,
  UUID,
  controlHash,
  nullableHash,
};
export type { ControlContext, Root, Snapshot, Pin, PublishedPin, ParentPin };
export type { CodexNetworkGuardPrivatePlan } from '../lib/codex-network-guard-private.ts';
export function networkFail(code: string): never {
  throw Error(code);
}
export const NATIVE_CODEX_PATH =
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
export const NATIVE_CODEX_SHA = 'a04752e4d46a4d89e53e6f61c59c5349a638c8ce172ffbf391fd482b4d902a4e';
export const NATIVE_CODEX_VERSION = 'codex-cli 0.164.0-alpha.11.1';
export type NativeBinding = {
  path: string;
  sha256: string;
  file: Pin;
  version: string;
  platform: 'darwin';
  parents: Root[];
};
export type GuardSource = {
  id: string;
  scope: 'user' | 'system' | 'project' | 'managed';
  path: string;
  root: Root;
  snapshot: Snapshot;
};
export type GuardOptions = ControlOptions & {
  nativeBinaryPath?: string;
  systemSources?: { path: string; scope: 'system' | 'managed' }[];
};
export type GuardHooks = {
  fault?: (stage: string) => Promise<void>;
  nativeCapture?: (options: GuardOptions) => Promise<NativeBinding>;
};
export type GuardCapture = {
  public: CodexNetworkGuardCapture;
  context: ControlContext;
  sources: GuardSource[];
  native: NativeBinding;
  binding: CodexNetworkGuardBinding;
  kind: CodexNetworkGuardKind | null;
  parentProfile: string | null;
  before: Snapshot;
};
export type GuardManifest = {
  schema: 'stroq-codex-network-record/1';
  id: string;
  operationId: string;
  controlContextId: string;
  rootBinding: string;
  target: string;
  sequence: number;
  ownedKeys: string[][];
  kind: CodexNetworkGuardKind;
  parentProfile: string | null;
  childProfile: string | null;
  createdAt: string;
  updatedAt: string;
  phase: 'prepared' | 'guarded' | 'restoring' | 'restored';
  originalSha256: string | null;
  candidateSha256: string;
  beforeBytes: number;
  candidateBytes: number;
  mode: number;
  nativeBinarySha256: string;
  captureSha256: string;
  sourceGraphSha256: string;
  staged: PublishedPin | null;
  parents: ParentPin[];
  publication: Pin | null;
  restoreSha256: string | null;
  restoreStaged: PublishedPin | null;
  restorePublication: Pin | null;
};
export type GuardRecord = {
  manifest: GuardManifest;
  revision: string;
  directory: string;
  path: string;
  before: Buffer | null;
  candidate: Buffer;
  owned: CodexNetworkGuardOwnership;
};
const filePin = (s: any): Pin => ({
  dev: s.dev,
  ino: s.ino,
  uid: s.uid,
  mode: s.mode,
  nlink: s.nlink,
  size: s.size,
  mtimeMs: s.mtimeMs,
  ctimeMs: s.ctimeMs,
});
/** Passive fixed executable capture. No --version, native client, auth or provider request. */
export async function captureGuardNative(options: GuardOptions): Promise<NativeBinding> {
  const path = options.nativeBinaryPath ?? NATIVE_CODEX_PATH;
  if (process.platform !== 'darwin' || !isAbsolute(path) || path !== NATIVE_CODEX_PATH)
    networkFail('codex-network-unsupported');
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > 512 * 1024 * 1024 ||
    (before.mode & 0o022) !== 0 ||
    (await realpath(path)) !== path
  )
    networkFail('codex-network-native-changed');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!same(filePin(await handle.stat()), filePin(before)))
      networkFail('codex-network-native-changed');
    const digest = createHash('sha256'),
      chunk = Buffer.alloc(128 * 1024);
    let position = 0;
    for (;;) {
      if (Date.now() >= options.deadline) networkFail('codex-network-stale');
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      if (position > before.size) networkFail('codex-network-native-changed');
      digest.update(chunk.subarray(0, bytesRead));
    }
    const sha256 = digest.digest('hex');
    if (
      position !== before.size ||
      !same(filePin(await handle.stat()), filePin(before)) ||
      !same(filePin(await lstat(path)), filePin(before)) ||
      sha256 !== NATIVE_CODEX_SHA
    )
      networkFail('codex-network-native-changed');
    const root = await import('./agent-setup-files.mjs').then((m) => m.rootIdentity(dirname(path)));
    return {
      path,
      sha256,
      file: filePin(before),
      version: NATIVE_CODEX_VERSION,
      platform: 'darwin',
      parents: [root],
    };
  } finally {
    await handle.close();
  }
}
