import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, rename } from 'node:fs/promises';
import { dirname, join, isAbsolute, relative, sep } from 'node:path';
import { parseStrictJson } from '../../packages/core/src/scope/strict-json.ts';
import { atomicWrite, snapshotFile } from './agent-setup-files.mjs';
import { closed, hash, stamp, text, count } from '../lib/local-guards.ts';
import { validateSkillLocation } from '../lib/skill-location.ts';
import { isCodexControlContext } from '../lib/codex-skill-controls.ts';
import { planCodexSkillDisable } from './codex-skill-control-toml.ts';
import {
  CONFIG_BYTES,
  MANIFEST_BYTES,
  RECORDS,
  STORE_BYTES,
  UUID,
  controlHash,
  owned,
  fail,
  same,
  publishedPin,
  type ControlContext,
  type ControlManifest,
  type ControlRecord,
  type Root,
} from './codex-skill-control-binding.ts';
import { validControlManifest, auditControlRemoval } from './codex-skill-control-manifest.ts';
async function privateRead(root: Root, path: string, max: number) {
  const result = await snapshotFile(root, path, max);
  if (
    result.bytes === null ||
    !result.file ||
    !owned(result.file) ||
    (result.file.mode & 0o777) !== 0o600 ||
    result.directories.some((d) => !owned(d) || (d.mode & 0o022) !== 0)
  )
    fail('codex-control-store-unavailable');
  return result;
}
async function location(context: ControlContext) {
  const path = join(context.user.path, '.stroq', 'codex-skill-controls'),
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
    fail('codex-control-store-unavailable');
  return { root: context.user, path, marker };
}
export async function syncControlDirectory(path: string) {
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
      fail('codex-control-store-unavailable');
    const read = await privateRead(root, join(path, entry.name), CONFIG_BYTES);
    bytes += read.bytes!.length;
    if (bytes > 2 * CONFIG_BYTES + 2 * MANIFEST_BYTES) fail('codex-control-store-unavailable');
  }
}
export async function readControlVault(context: ControlContext) {
  try {
    const loc = await location(context),
      records: ControlRecord[] = [];
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
          fail('codex-control-store-unavailable');
        count++;
        const p = await privateRead(loc.root, join(loc.path, item.name), 2);
        if (!Buffer.from('*\n').subarray(0, p.bytes!.length).equals(p.bytes!))
          fail('codex-control-store-unavailable');
        continue;
      }
      if (loc.marker.bytes === null) fail('codex-control-store-unavailable');
      const staged = item.name.startsWith('.prepared-') && UUID.test(item.name.slice(10));
      if (++count > RECORDS || !item.isDirectory() || (!UUID.test(item.name) && !staged))
        fail('codex-control-store-unavailable');
      const directory = join(loc.path, item.name),
        stat = await lstat(directory);
      if (!owned(stat) || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700)
        fail('codex-control-store-unavailable');
      if (staged) {
        await boundedStaging(loc.root, directory);
        total += 2 * CONFIG_BYTES + 2 * MANIFEST_BYTES;
        continue;
      }
      let files = 0,
        temporary = 0;
      for await (const file of await opendir(directory)) {
        if (!file.isFile() || ++files > 4) fail('codex-control-store-unavailable');
        if (/^\.stroq-[a-f0-9-]{36}\.tmp$/.test(file.name)) {
          pendingStaging = true;
          if (++temporary > 1) fail('codex-control-store-unavailable');
          await privateRead(loc.root, join(directory, file.name), MANIFEST_BYTES);
        } else if (!['before.toml', 'candidate.toml', 'record.json'].includes(file.name))
          fail('codex-control-store-unavailable');
      }
      if (files - temporary !== 3) fail('codex-control-store-unavailable');
      const path = join(directory, 'record.json'),
        read = await privateRead(loc.root, path, MANIFEST_BYTES),
        parsed = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes!));
      if (!parsed.ok || !validControlManifest(parsed.value, item.name))
        fail('codex-control-store-unavailable');
      const manifest = parsed.value,
        before = await privateRead(loc.root, join(directory, 'before.toml'), CONFIG_BYTES),
        candidate = await privateRead(loc.root, join(directory, 'candidate.toml'), CONFIG_BYTES);
      const original = manifest.originalSha256 === null ? null : before.bytes!;
      if (
        before.bytes!.length !== manifest.beforeBytes ||
        candidate.bytes!.length !== manifest.candidateBytes ||
        (original === null
          ? before.bytes!.length !== 0
          : before.sha256 !== manifest.originalSha256) ||
        candidate.sha256 !== manifest.candidateSha256 ||
        manifest.rootBinding !== context.rootBinding
      )
        fail('codex-control-store-unavailable');
      const rel = relative(context.user.path, manifest.target);
      if (
        isAbsolute(rel) ||
        rel === '..' ||
        rel.startsWith(`..${sep}`) ||
        !manifest.target.endsWith(`${sep}config.toml`)
      )
        fail('codex-control-store-unavailable');
      await auditControlRemoval(loc.root, manifest);
      const derived = planCodexSkillDisable({
        bytes: original,
        documentPath: manifest.documentPath,
        operationId: manifest.id,
      });
      if (!Buffer.from(derived.bytes).equals(candidate.bytes!))
        fail('codex-control-store-unavailable');
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
    if (total > STORE_BYTES) fail('codex-control-store-unavailable');
    return {
      ...loc,
      records,
      count,
      bytes: total,
      missing: loc.marker.bytes === null,
      pendingStaging,
    };
  } catch {
    fail('codex-control-store-unavailable');
  }
}
export async function saveControlManifest(
  context: ControlContext,
  manifest: ControlManifest,
  expected: string | null,
  guard: () => Promise<void>,
  path?: string,
) {
  const loc = await location(context),
    target = path ?? join(loc.path, manifest.id, 'record.json'),
    bytes = Buffer.from(`${JSON.stringify(manifest)}\n`),
    before = await snapshotFile(loc.root, target, MANIFEST_BYTES);
  if (
    !validControlManifest(manifest, manifest.id) ||
    bytes.length > MANIFEST_BYTES ||
    (expected === null ? before.bytes !== null : before.sha256 !== expected)
  )
    fail('codex-control-recovery-required');
  for await (const entry of await opendir(dirname(target))) {
    if (/^\.stroq-[a-f0-9-]{36}\.tmp$/.test(entry.name)) fail('codex-control-recovery-required');
  }
  await guard();
  await atomicWrite(loc.root, target, bytes, before, 0o600, {
    fault: async (stage: string) => {
      if (stage === 'before-rename') await guard();
    },
  });
  await syncControlDirectory(dirname(target));
  const current = await privateRead(loc.root, target, MANIFEST_BYTES);
  if (!current.bytes!.equals(bytes)) fail('codex-control-write-unconfirmed');
  return current.sha256;
}
export async function createControlRecord(
  context: ControlContext,
  manifest: ControlManifest,
  before: Buffer | null,
  candidate: Buffer,
  guard: () => Promise<void>,
) {
  const vault = await readControlVault(context),
    reserve = (before?.length ?? 0) + candidate.length + 2 * MANIFEST_BYTES;
  if (vault.count >= RECORDS || vault.bytes + reserve > STORE_BYTES)
    fail('codex-control-store-full');
  if (vault.records.some((r) => ['prepared', 'restoring'].includes(r.manifest.phase)))
    fail('codex-control-recovery-required');
  await guard();
  if (vault.marker.bytes === null) {
    await atomicWrite(
      vault.root,
      join(vault.path, '.gitignore'),
      Buffer.from('*\n'),
      vault.marker,
      0o600,
      {
        fault: async (stage: string) => {
          if (stage === 'before-rename') await guard();
        },
      },
    );
    await syncControlDirectory(vault.path);
  }
  const directory = join(vault.path, `.prepared-${manifest.id}`);
  await mkdir(directory, { mode: 0o700 });
  for (const [name, bytes] of [
    ['before.toml', before ?? Buffer.alloc(0)],
    ['candidate.toml', candidate],
  ] as const) {
    const path = join(directory, name),
      missing = await snapshotFile(vault.root, path, CONFIG_BYTES);
    if (missing.bytes !== null) fail('codex-control-store-unavailable');
    await atomicWrite(vault.root, path, bytes, missing, 0o600, {
      fault: async (stage: string) => {
        if (stage === 'before-rename') await guard();
      },
    });
  }
  await saveControlManifest(context, manifest, null, guard, join(directory, 'record.json'));
  await syncControlDirectory(directory);
  await guard();
  const final = join(vault.path, manifest.id);
  try {
    await lstat(final);
    fail('codex-control-recovery-required');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  await rename(directory, final);
  await syncControlDirectory(vault.path);
  return getControlRecord(context, manifest.id);
}
export async function getControlRecord(context: ControlContext, id: string, revision?: string) {
  if (!UUID.test(id)) fail('codex-control-stale');
  const record = (await readControlVault(context)).records.find(
    (r) =>
      r.manifest.id === id &&
      r.manifest.controlContextId === context.id &&
      r.manifest.target === context.target,
  );
  if (!record || (revision !== undefined && record.revision !== revision))
    fail('codex-control-stale');
  return record;
}
