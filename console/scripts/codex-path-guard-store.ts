import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, rename } from 'node:fs/promises';
import { dirname, join, isAbsolute, relative, sep } from 'node:path';
import { parseStrictJson } from '../../packages/core/src/scope/strict-json.ts';
import { atomicWrite, snapshotFile } from './agent-setup-files.mjs';
import { planCodexPathGuard } from './codex-path-guard-toml.ts';
import { pathGuardTargetPath } from './codex-path-guard-targets.ts';
import {
  CONFIG_BYTES,
  MANIFEST_BYTES,
  RECORDS,
  STORE_BYTES,
  UUID,
  controlHash,
  owned,
  pathFail as fail,
  same,
  publishedPin,
  type ControlContext,
  type PathGuardManifest,
  type PathGuardRecord,
  type Root,
} from './codex-path-guard-binding.ts';
import { pathGuardOwnedKeys } from './codex-path-guard-ownership.ts';
import { validPathGuardManifest } from './codex-path-guard-manifest.ts';
async function privateRead(root: Root, path: string, max: number) {
  const result = await snapshotFile(root, path, max);
  if (
    result.bytes === null ||
    !result.file ||
    !owned(result.file) ||
    (result.file.mode & 0o777) !== 0o600 ||
    result.directories.some((d) => !owned(d) || (d.mode & 0o022) !== 0)
  )
    fail('codex-path-guard-store-unavailable');
  return result;
}
async function location(context: ControlContext) {
  const path = join(context.user.path, '.stroq', 'codex-path-guard'),
    marker = await snapshotFile(context.user, join(path, '.gitignore'), 2);
  if (
    marker.directories.some(
      (d) =>
        !owned(d) ||
        (d.mode & 0o022) !== 0 ||
        (d.path !== context.user.path && (d.mode & 0o777) !== 0o700),
    ) ||
    (marker.file && (!owned(marker.file) || (marker.file.mode & 0o777) !== 0o600)) ||
    (marker.bytes !== null && !marker.bytes.equals(Buffer.from('*\n')))
  )
    fail('codex-path-guard-store-unavailable');
  return { root: context.user, path, marker };
}
export async function syncPathGuardDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    await handle.sync();
  } catch (e) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
  } finally {
    await handle.close();
  }
}
async function boundedStaging(root: Root, path: string) {
  let entries = 0,
    bytes = 0;
  for await (const entry of await opendir(path)) {
    if (
      ++entries > 4 ||
      !entry.isFile() ||
      !(
        ['before.toml', 'candidate.toml', 'record.json'].includes(entry.name) ||
        /^\.stroq-[a-f0-9-]{36}\.tmp$/.test(entry.name)
      )
    )
      fail('codex-path-guard-store-unavailable');
    const read = await privateRead(root, join(path, entry.name), CONFIG_BYTES);
    bytes += read.bytes!.length;
    if (bytes > 2 * CONFIG_BYTES + 2 * MANIFEST_BYTES) fail('codex-path-guard-store-unavailable');
  }
}
export async function readPathGuardVault(context: ControlContext) {
  try {
    const loc = await location(context),
      records: PathGuardRecord[] = [];
    try {
      await lstat(loc.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return {
          ...loc,
          records,
          count: 0,
          bytes: CONFIG_BYTES,
          missing: true,
          pendingStaging: false,
        };
      throw e;
    }
    let total = CONFIG_BYTES + 2,
      pendingStaging = false,
      count = 0,
      markerStaging = 0;
    for await (const item of await opendir(loc.path, { bufferSize: 4 })) {
      if (item.name === '.gitignore') continue;
      if (/^\.stroq-[a-f0-9-]{36}\.tmp$/.test(item.name)) {
        if (++markerStaging > 1 || loc.marker.bytes !== null)
          fail('codex-path-guard-store-unavailable');
        count++;
        const p = await privateRead(loc.root, join(loc.path, item.name), 2);
        if (!Buffer.from('*\n').subarray(0, p.bytes!.length).equals(p.bytes!))
          fail('codex-path-guard-store-unavailable');
        continue;
      }
      if (loc.marker.bytes === null) fail('codex-path-guard-store-unavailable');
      const staged = item.name.startsWith('.prepared-') && UUID.test(item.name.slice(10));
      if (++count > RECORDS || !item.isDirectory() || (!UUID.test(item.name) && !staged))
        fail('codex-path-guard-store-unavailable');
      const directory = join(loc.path, item.name),
        stat = await lstat(directory);
      if (!owned(stat) || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700)
        fail('codex-path-guard-store-unavailable');
      if (staged) {
        await boundedStaging(loc.root, directory);
        total += 2 * CONFIG_BYTES + 2 * MANIFEST_BYTES;
        continue;
      }
      let files = 0,
        temporary = 0;
      for await (const file of await opendir(directory)) {
        if (!file.isFile() || ++files > 4) fail('codex-path-guard-store-unavailable');
        if (/^\.stroq-[a-f0-9-]{36}\.tmp$/.test(file.name)) {
          pendingStaging = true;
          if (++temporary > 1) fail('codex-path-guard-store-unavailable');
          await privateRead(loc.root, join(directory, file.name), MANIFEST_BYTES);
        } else if (!['before.toml', 'candidate.toml', 'record.json'].includes(file.name))
          fail('codex-path-guard-store-unavailable');
      }
      if (files - temporary !== 3) fail('codex-path-guard-store-unavailable');
      const path = join(directory, 'record.json'),
        read = await privateRead(loc.root, path, MANIFEST_BYTES),
        parsed = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes!));
      if (!parsed.ok || !validPathGuardManifest(parsed.value, item.name))
        fail('codex-path-guard-store-unavailable');
      const manifest = parsed.value,
        before = await privateRead(loc.root, join(directory, 'before.toml'), CONFIG_BYTES),
        candidate = await privateRead(loc.root, join(directory, 'candidate.toml'), CONFIG_BYTES);
      const original = before.bytes!;
      if (
        before.bytes!.length !== manifest.beforeBytes ||
        candidate.bytes!.length !== manifest.candidateBytes ||
        before.sha256 !== manifest.originalSha256 ||
        candidate.sha256 !== manifest.candidateSha256 ||
        manifest.rootBinding !== context.rootBinding
      )
        fail('codex-path-guard-store-unavailable');
      const rel = relative(context.user.path, manifest.target);
      if (
        isAbsolute(rel) ||
        rel === '..' ||
        rel.startsWith(`..${sep}`) ||
        !manifest.target.endsWith(`${sep}config.toml`)
      )
        fail('codex-path-guard-store-unavailable');
      const derived = planCodexPathGuard({
        bytes: original,
        targetPath: manifest.credentialTarget,
        operationId: manifest.id,
      });
      if (
        !Buffer.from(derived.bytes).equals(candidate.bytes!) ||
        !same(pathGuardOwnedKeys(derived.owned), manifest.ownedKeys) ||
        derived.profileName !== manifest.profileName ||
        manifest.credentialTarget !== pathGuardTargetPath(context.user, manifest.presetId)
      )
        fail('codex-path-guard-store-unavailable');
      total += before.bytes!.length + candidate.bytes!.length + 2 * MANIFEST_BYTES;
      records.push({
        manifest,
        revision: read.sha256,
        directory,
        path,
        before: original,
        candidate: candidate.bytes!,
        owned: derived.owned,
      });
    }
    if (new Set(records.map((r) => r.manifest.sequence)).size !== records.length)
      fail('codex-path-guard-store-unavailable');
    if (total > STORE_BYTES) fail('codex-path-guard-store-unavailable');
    return {
      ...loc,
      records,
      count,
      bytes: total,
      missing: loc.marker.bytes === null,
      pendingStaging,
    };
  } catch {
    fail('codex-path-guard-store-unavailable');
  }
}
export async function savePathGuardManifest(
  context: ControlContext,
  manifest: PathGuardManifest,
  expected: string | null,
  guard: () => Promise<void>,
  path?: string,
) {
  const loc = await location(context),
    target = path ?? join(loc.path, manifest.id, 'record.json');
  if (
    !validPathGuardManifest(manifest, manifest.id) ||
    ![
      join(loc.path, manifest.id, 'record.json'),
      join(loc.path, `.prepared-${manifest.id}`, 'record.json'),
    ].includes(target)
  )
    fail('codex-path-guard-recovery-required');
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  if (bytes.length > MANIFEST_BYTES) fail('codex-path-guard-recovery-required');
  const before = await snapshotFile(loc.root, target, MANIFEST_BYTES);
  if (expected === null ? before.bytes !== null : before.sha256 !== expected)
    fail('codex-path-guard-recovery-required');
  if (before.bytes !== null) {
    await privateRead(loc.root, target, MANIFEST_BYTES);
    const parsed = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(before.bytes));
    const mutable = new Set([
      'operationId',
      'updatedAt',
      'phase',
      'staged',
      'parents',
      'publication',
      'restoreSha256',
      'restoreStaged',
      'restorePublication',
    ]);
    if (!parsed.ok || !validPathGuardManifest(parsed.value, manifest.id))
      fail('codex-path-guard-recovery-required');
    const previous = parsed.value;
    if (
      Object.keys(manifest).some(
        (k) =>
          !mutable.has(k) &&
          !same(manifest[k as keyof PathGuardManifest], previous[k as keyof PathGuardManifest]),
      )
    )
      fail('codex-path-guard-recovery-required');
  }
  for await (const entry of await opendir(dirname(target))) {
    if (/^\.stroq-[a-f0-9-]{36}\.tmp$/.test(entry.name)) fail('codex-path-guard-recovery-required');
  }
  await guard();
  await atomicWrite(loc.root, target, bytes, before, 0o600, {
    fault: async (stage?: string) => {
      if (stage === 'before-rename') await guard();
    },
  });
  await syncPathGuardDirectory(dirname(target));
  const current = await privateRead(loc.root, target, MANIFEST_BYTES);
  if (!current.bytes!.equals(bytes)) fail('codex-path-guard-write-unconfirmed');
  return current.sha256;
}
export async function createPathGuardRecord(
  context: ControlContext,
  manifest: PathGuardManifest,
  before: Buffer | null,
  candidate: Buffer,
  guard: () => Promise<void>,
) {
  if (
    !validPathGuardManifest(manifest, manifest.id) ||
    before === null ||
    before.length > CONFIG_BYTES ||
    candidate.length > CONFIG_BYTES ||
    manifest.controlContextId !== context.id ||
    manifest.rootBinding !== context.rootBinding ||
    manifest.target !== context.target ||
    manifest.originalSha256 !== controlHash(before) ||
    manifest.candidateSha256 !== controlHash(candidate) ||
    manifest.beforeBytes !== before.length ||
    manifest.candidateBytes !== candidate.length ||
    manifest.credentialTarget !== pathGuardTargetPath(context.user, manifest.presetId)
  )
    fail('codex-path-guard-recovery-required');
  const derived = planCodexPathGuard({
    bytes: before,
    operationId: manifest.id,
    targetPath: manifest.credentialTarget,
  });
  if (
    !Buffer.from(derived.bytes).equals(candidate) ||
    derived.profileName !== manifest.profileName ||
    !same(pathGuardOwnedKeys(derived.owned), manifest.ownedKeys)
  )
    fail('codex-path-guard-recovery-required');
  const vault = await readPathGuardVault(context),
    reserve = 2 * CONFIG_BYTES + 2 * MANIFEST_BYTES;
  if (vault.count >= RECORDS || vault.bytes + reserve > STORE_BYTES)
    fail('codex-path-guard-store-full');
  if (
    before === null ||
    manifest.sequence !== Math.max(0, ...vault.records.map((r) => r.manifest.sequence)) + 1 ||
    vault.pendingStaging ||
    vault.count > vault.records.length ||
    vault.records.some((r) => ['prepared', 'restoring'].includes(r.manifest.phase))
  )
    fail('codex-path-guard-recovery-required');
  await guard();
  if (vault.marker.bytes === null) {
    await atomicWrite(
      vault.root,
      join(vault.path, '.gitignore'),
      Buffer.from('*\n'),
      vault.marker,
      0o600,
      {
        fault: async (stage?: string) => {
          if (stage === 'before-rename') await guard();
        },
      },
    );
    await syncPathGuardDirectory(vault.path);
  }
  const directory = join(vault.path, `.prepared-${manifest.id}`);
  await mkdir(directory, { mode: 0o700 });
  for (const [name, bytes] of [
    ['before.toml', before ?? Buffer.alloc(0)],
    ['candidate.toml', candidate],
  ] as const) {
    const path = join(directory, name),
      missing = await snapshotFile(vault.root, path, CONFIG_BYTES);
    if (missing.bytes !== null) fail('codex-path-guard-store-unavailable');
    await atomicWrite(vault.root, path, bytes, missing, 0o600, {
      fault: async (stage?: string) => {
        if (stage === 'before-rename') await guard();
      },
    });
  }
  await savePathGuardManifest(context, manifest, null, guard, join(directory, 'record.json'));
  await syncPathGuardDirectory(directory);
  await guard();
  const final = join(vault.path, manifest.id);
  try {
    await lstat(final);
    fail('codex-path-guard-recovery-required');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  await rename(directory, final);
  await syncPathGuardDirectory(vault.path);
  return getPathGuardRecord(context, manifest.id);
}
export async function getPathGuardRecord(context: ControlContext, id: string, revision?: string) {
  if (!UUID.test(id)) fail('codex-path-guard-stale');
  const record = (await readPathGuardVault(context)).records.find(
    (r) =>
      r.manifest.id === id &&
      r.manifest.controlContextId === context.id &&
      r.manifest.target === context.target,
  );
  if (!record || (revision !== undefined && record.revision !== revision))
    fail('codex-path-guard-stale');
  return record;
}
