import * as control from './codex-skill-control-binding.ts';
import { captureGuardNative as captureNative } from './codex-network-guard-binding.ts';
export {
  NATIVE_CODEX_PATH,
  NATIVE_CODEX_SHA,
  NATIVE_CODEX_VERSION,
} from './codex-network-guard-binding.ts';
import type { CodexPathGuardPresetId } from '../lib/codex-path-guard.ts';
import type { CodexPathGuardOwnership } from './codex-path-guard-toml.ts';
export {
  CONFIG_BYTES,
  MANIFEST_BYTES,
  RECORDS,
  STORE_BYTES,
  UUID,
  controlHash,
  nullableHash,
  controlParents,
  publishedPin,
  same,
  owned,
} from './codex-skill-control-binding.ts';
export type {
  ControlContext,
  ControlOptions,
  Root,
  Snapshot,
  Pin,
  PublishedPin,
  ParentPin,
} from './codex-skill-control-binding.ts';
export type {
  GuardOptions,
  GuardHooks,
  GuardSource,
  NativeBinding,
  GuardCapture,
} from './codex-network-guard-binding.ts';
export type { PathGuardCapture } from './codex-path-guard-capture.ts';
export type { CodexPathGuardPrivatePlan } from '../lib/codex-path-guard-private.ts';
export function pathFail(code: string): never {
  throw Error(code);
}
const mapped = async <T>(action: () => Promise<T>): Promise<T> => {
  try {
    return await action();
  } catch (e) {
    const code = (e as Error)?.message;
    if (code?.startsWith('codex-control-'))
      return pathFail(code.replace('codex-control-', 'codex-path-guard-'));
    if (code?.startsWith('codex-network-'))
      return pathFail(code.replace('codex-network-', 'codex-path-guard-'));
    if (code?.startsWith('codex-path-guard-')) throw e;
    return pathFail('codex-path-guard-unavailable');
  }
};
export const controlContext = (...args: Parameters<typeof control.controlContext>) =>
  mapped(() => control.controlContext(...args));
export const sourceSnapshot = (...args: Parameters<typeof control.sourceSnapshot>) =>
  mapped(() => control.sourceSnapshot(...args));
export const assertContext = (...args: Parameters<typeof control.assertContext>) =>
  mapped(() => control.assertContext(...args));
export const assertRuntime = (...args: Parameters<typeof control.assertRuntime>) =>
  mapped(() => control.assertRuntime(...args));
export const captureGuardNative = (...args: Parameters<typeof captureNative>) =>
  mapped(() => captureNative(...args));
export type PathGuardManifest = {
  schema: 'stroq-codex-path-record/1';
  id: string;
  operationId: string;
  controlContextId: string;
  rootBinding: string;
  target: string;
  sequence: number;
  ownedKeys: string[][];
  kind: 'profile-path-deny';
  presetId: CodexPathGuardPresetId;
  profileName: string;
  credentialTarget: string;
  targetMetadataSha256: string;
  dependencySha256: string;
  createdAt: string;
  updatedAt: string;
  phase: 'prepared' | 'guarded' | 'restoring' | 'restored';
  originalSha256: string;
  candidateSha256: string;
  beforeBytes: number;
  candidateBytes: number;
  mode: number;
  nativeBinarySha256: string;
  captureSha256: string;
  sourceGraphSha256: string;
  staged: control.PublishedPin | null;
  parents: control.ParentPin[];
  publication: control.Pin | null;
  restoreSha256: string | null;
  restoreStaged: control.PublishedPin | null;
  restorePublication: control.Pin | null;
};
export type PathGuardRecord = {
  manifest: PathGuardManifest;
  revision: string;
  directory: string;
  path: string;
  before: Buffer;
  candidate: Buffer;
  owned: CodexPathGuardOwnership;
};
