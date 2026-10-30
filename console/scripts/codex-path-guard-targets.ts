import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { inspectPath, rootIdentity } from './agent-setup-files.mjs';
import {
  CODEX_PATH_GUARD_PRESETS,
  type CodexPathGuardPresetId,
} from '../lib/codex-path-guard-types.ts';
import type { Root, Pin } from './codex-skill-control-binding.ts';

const routes: Record<CodexPathGuardPresetId, readonly string[]> = {
  'aws-credentials': ['.aws', 'credentials'],
  'ssh-ed25519': ['.ssh', 'id_ed25519'],
  'ssh-rsa': ['.ssh', 'id_rsa'],
  npmrc: ['.npmrc'],
  netrc: ['.netrc'],
  pgpass: ['.pgpass'],
  'git-credentials': ['.git-credentials'],
};
export type PathGuardTarget = {
  id: CodexPathGuardPresetId;
  path: string;
  status: 'regular' | 'absent' | 'unsafe' | 'unavailable';
  directories: Root[];
  file: Pin | null;
};
export type PathGuardTargets = { targets: PathGuardTarget[]; sha256: string };
const fingerprint = (targets: PathGuardTarget[]) =>
  createHash('sha256').update(JSON.stringify(targets)).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code: string): never => {
  throw Error('codex-path-guard-' + code);
};
export function pathGuardTargetPath(user: Root, id: unknown): string {
  if (typeof id !== 'string' || !CODEX_PATH_GUARD_PRESETS.includes(id as CodexPathGuardPresetId))
    return fail('invalid');
  return join(user.path, ...routes[id as CodexPathGuardPresetId]);
}
/** History and config-only Restore need no observation of a credential route. */
export function unobservedPathGuardTargets(user: Root): PathGuardTargets {
  const targets: PathGuardTarget[] = CODEX_PATH_GUARD_PRESETS.map((id) => ({
    id,
    path: pathGuardTargetPath(user, id),
    status: 'unavailable',
    directories: [],
    file: null,
  }));
  return { targets, sha256: fingerprint(targets) };
}
async function assertUser(user: Root) {
  if (!same(await rootIdentity(user.path), user)) fail('stale');
}
async function inspect(user: Root, id: CodexPathGuardPresetId): Promise<PathGuardTarget> {
  const path = pathGuardTargetPath(user, id);
  try {
    // inspectPath performs lstat/realpath only. Never use snapshotFile for credential targets.
    const inspected = await inspectPath(user, path);
    if (
      inspected.directories.some((d: Root) => d.uid !== user.uid || (d.mode & 0o022) !== 0) ||
      (inspected.file && inspected.file.uid !== user.uid)
    )
      return fail('target-unsafe');
    return {
      id,
      path,
      status: inspected.exists ? 'regular' : 'absent',
      directories: inspected.directories,
      file: inspected.file,
    };
  } catch {
    return { id, path, status: 'unsafe', directories: [], file: null };
  }
}
/** Only fixed-route metadata is captured, including unreadable regular files. */
export async function capturePathGuardTargets(user: Root): Promise<PathGuardTargets> {
  await assertUser(user);
  const targets = await Promise.all(CODEX_PATH_GUARD_PRESETS.map((id) => inspect(user, id)));
  const current = await Promise.all(CODEX_PATH_GUARD_PRESETS.map((id) => inspect(user, id)));
  await assertUser(user);
  if (!same(targets, current)) return fail('stale');
  return { targets, sha256: fingerprint(targets) };
}
export async function assertPathGuardTargets(user: Root, captured: PathGuardTargets) {
  try {
    const current = await capturePathGuardTargets(user);
    if (!same(current, captured)) fail('stale');
  } catch {
    fail('stale');
  }
}
