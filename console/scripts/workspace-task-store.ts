import { lstat, mkdir, open, opendir, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseStrictJson } from '../../packages/core/src/scope/strict-json.ts';
import { atomicWrite, rootIdentity, snapshotFile } from './agent-setup-files.mjs';
import {
  TASK_BYTES,
  TASK_RECORDS,
  TASK_STORE_BYTES,
  MANIFEST_BYTES,
  UUID,
  owned,
  assertTaskContext,
  taskFail,
  validManifest,
  taskRootBinding,
  taskHash,
  type TaskOptions,
  type TaskRoot,
  type TaskManifest,
  type TaskRecord,
} from './workspace-task-binding.ts';
export * from './workspace-task-binding.ts';
// The full reservation includes the previous and staged atomic metadata versions.
const RECORD_BYTES = MANIFEST_BYTES / 2;

async function location(options: TaskOptions) {
  const home = resolve(options.home),
    path = join(home, 'console', 'workspace-task-controls');
  let at = home;
  for (;;) {
    try {
      await lstat(at);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(at) === at) throw error;
      at = dirname(at);
    }
  }
  const root = await rootIdentity(at),
    before = await snapshotFile(root, join(path, '.gitignore'), 32);
  if (
    before.directories.some(
      (d) =>
        !owned(d) ||
        (d.mode & 0o022) !== 0 ||
        ((d.path.startsWith(`${home}/`) || d.path === home) && (d.mode & 0o777) !== 0o700),
    ) ||
    (before.file && (!owned(before.file) || (before.file.mode & 0o777) !== 0o600)) ||
    (before.bytes !== null && !before.bytes.equals(Buffer.from('*\n')))
  )
    taskFail('task-store-unavailable');
  return { root, path, marker: before };
}
async function privateRead(root: TaskRoot, path: string, max: number) {
  const result = await snapshotFile(root, path, max);
  if (
    result.bytes === null ||
    !result.file ||
    !owned(result.file) ||
    (result.file.mode & 0o777) !== 0o600 ||
    result.directories.some((d) => !owned(d) || (d.mode & 0o022) !== 0)
  )
    taskFail('task-store-unavailable');
  return result;
}
async function inspectStaging(root: TaskRoot, directory: string) {
  const listing = await opendir(directory, { bufferSize: 4 });
  let files = 0,
    bytes = 0;
  for await (const file of listing) {
    if (
      ++files > 4 ||
      !file.isFile() ||
      (!['before.jsonc', 'record.json'].includes(file.name) &&
        !/^\.stroq-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.tmp$/.test(file.name))
    )
      taskFail('task-store-unavailable');
    const result = await privateRead(root, join(directory, file.name), TASK_BYTES);
    bytes += result.bytes!.length;
    if (
      bytes > TASK_BYTES + MANIFEST_BYTES ||
      (file.name === 'record.json' && result.bytes!.length > RECORD_BYTES)
    )
      taskFail('task-store-unavailable');
  }
  return TASK_BYTES + MANIFEST_BYTES;
}
export async function readTaskVault(options: TaskOptions) {
  try {
    await assertTaskContext(options);
    const loc = await location(options),
      records: TaskRecord[] = [];
    if (loc.marker.bytes === null) {
      try {
        await lstat(loc.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return { ...loc, records, count: 0, bytes: 0 };
      }
    }
    const listing = await opendir(loc.path, { bufferSize: 4 });
    let count = 0,
      bytes = 2;
    for await (const item of listing) {
      if (item.name === '.gitignore') continue;
      if (/^\.stroq-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.tmp$/.test(item.name)) {
        if (++count > TASK_RECORDS || !item.isFile()) taskFail('task-store-unavailable');
        const partialMarker = await privateRead(loc.root, join(loc.path, item.name), 2);
        if (
          !Buffer.from('*\n').subarray(0, partialMarker.bytes!.length).equals(partialMarker.bytes!)
        )
          taskFail('task-store-unavailable');
        bytes += 2;
        continue;
      }
      if (loc.marker.bytes === null) taskFail('task-store-unavailable');
      const staging = item.name.startsWith('.prepared-') && UUID.test(item.name.slice(10));
      if (++count > TASK_RECORDS || !item.isDirectory() || (!UUID.test(item.name) && !staging))
        taskFail('task-store-unavailable');
      const directory = join(loc.path, item.name),
        path = join(directory, 'record.json');
      const directoryStat = await lstat(directory);
      if (
        !owned(directoryStat) ||
        (directoryStat.mode & 0o777) !== 0o700 ||
        directoryStat.isSymbolicLink()
      )
        taskFail('task-store-unavailable');
      if (staging) {
        bytes += await inspectStaging(loc.root, directory);
        if (bytes > TASK_STORE_BYTES) taskFail('task-store-unavailable');
        continue;
      }
      const contents = await opendir(directory, { bufferSize: 4 });
      let files = 0;
      for await (const entry of contents) {
        if (++files > 2 || !['record.json', 'before.jsonc'].includes(entry.name) || !entry.isFile())
          taskFail('task-store-unavailable');
      }
      if (files !== 2) taskFail('task-store-unavailable');
      const read = await privateRead(loc.root, path, RECORD_BYTES),
        backup = await privateRead(loc.root, join(directory, 'before.jsonc'), TASK_BYTES);
      const parsed = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes!));
      if (!parsed.ok || !validManifest(parsed.value, item.name)) taskFail('task-store-unavailable');
      const manifest = parsed.value;
      if (backup.bytes!.length !== manifest.bytes || backup.sha256 !== manifest.source.sourceSha256)
        taskFail('task-store-unavailable');
      // Reserve the full bounded metadata allowance so later phase publication cannot
      // exceed the global budget even when every retained record grows.
      bytes += MANIFEST_BYTES + backup.bytes!.length;
      if (bytes > TASK_STORE_BYTES) taskFail('task-store-unavailable');
      if (manifest.storeId === options.storeId) {
        if (
          manifest.workspaceId !== options.workspaceId ||
          manifest.rootBinding !== taskRootBinding(options)
        )
          taskFail('task-store-unavailable');
        records.push({ manifest, revision: read.sha256, directory, path, backup: backup.bytes! });
      }
    }
    return { ...loc, records, count, bytes };
  } catch (error) {
    if ((error as Error).message === 'deadline-exceeded') throw error;
    taskFail('task-store-unavailable');
  }
}
export async function syncTaskDirectory(path: string) {
  const root = await rootIdentity(path),
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (stat.dev !== root.dev || stat.ino !== root.ino) taskFail('task-store-unavailable');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw error;
  } finally {
    await handle.close();
  }
}
async function writeManifest(
  options: TaskOptions,
  record: TaskManifest,
  expected: string | null,
  beforeCommit: () => Promise<void>,
  path: string,
) {
  await beforeCommit();
  const loc = await location(options);
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`),
    before = await snapshotFile(loc.root, path, RECORD_BYTES);
  if (
    !validManifest(record, record.id) ||
    bytes.length > RECORD_BYTES ||
    (expected === null ? before.bytes !== null : before.sha256 !== expected)
  )
    taskFail('task-recovery-required');
  await atomicWrite(loc.root, path, bytes, before, 0o600, {
    fault: async (stage?: string) => {
      if (stage === 'before-rename') await beforeCommit();
    },
  });
  await syncTaskDirectory(dirname(path));
  const read = await privateRead(loc.root, path, RECORD_BYTES);
  if (!read.bytes!.equals(bytes)) taskFail('task-write-unconfirmed');
  return read.sha256;
}
export async function saveTaskManifest(
  options: TaskOptions,
  record: TaskManifest,
  expected: string | null,
  beforeCommit: () => Promise<void>,
) {
  const loc = await location(options);
  return writeManifest(
    options,
    record,
    expected,
    beforeCommit,
    join(loc.path, record.id, 'record.json'),
  );
}
export async function createTaskRecord(
  options: TaskOptions,
  record: TaskManifest,
  backup: Buffer,
  beforeCommit: () => Promise<void>,
) {
  const vault = await readTaskVault(options),
    estimate = MANIFEST_BYTES + TASK_BYTES;
  if (vault.count >= TASK_RECORDS || vault.bytes + estimate > TASK_STORE_BYTES)
    taskFail('task-store-full');
  if (vault.marker.bytes === null) {
    await atomicWrite(
      vault.root,
      join(vault.path, '.gitignore'),
      Buffer.from('*\n'),
      vault.marker,
      0o600,
      {
        fault: async (stage?: string) => {
          if (stage === 'before-rename') await beforeCommit();
        },
      },
    );
    await syncTaskDirectory(vault.path);
  }
  const directory = join(vault.path, `.prepared-${record.id}`);
  await beforeCommit();
  await mkdir(directory, { mode: 0o700 });
  const target = join(directory, 'before.jsonc'),
    missing = await snapshotFile(vault.root, target, TASK_BYTES);
  if (missing.bytes !== null) taskFail('task-store-unavailable');
  await atomicWrite(vault.root, target, backup, missing, 0o600, {
    fault: async (stage?: string) => {
      if (stage === 'before-rename') await beforeCommit();
    },
  });
  await writeManifest(options, record, null, beforeCommit, join(directory, 'record.json'));
  await syncTaskDirectory(directory);
  const prepared = await privateRead(vault.root, join(directory, 'record.json'), RECORD_BYTES),
    saved = await privateRead(vault.root, target, TASK_BYTES);
  if (!saved.bytes!.equals(backup) || prepared.sha256 !== taskHash(`${JSON.stringify(record)}\n`))
    taskFail('task-write-unconfirmed');
  await beforeCommit();
  const final = join(vault.path, record.id);
  try {
    await lstat(final);
    taskFail('task-recovery-required');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await rename(directory, final);
  await syncTaskDirectory(vault.path);
  return (await readTaskVault(options)).records.find((r) => r.manifest.id === record.id)!;
}
export async function taskRecord(options: TaskOptions, id: string, revision?: string) {
  if (!UUID.test(id)) taskFail('invalid-request');
  const record = (await readTaskVault(options)).records.find((r) => r.manifest.id === id);
  if (!record || (revision !== undefined && record.revision !== revision))
    taskFail('stale-task-source');
  return record;
}
