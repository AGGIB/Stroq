import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { isTaskId, stableStringify } from '@stroq/core';
import {
  assertLocation,
  binding,
  checkDeadline,
  directory,
  fail,
  filePin,
  hash,
  location,
  same,
  type FilePin,
  type Location,
  type Options,
} from './task-lock-files.js';
import {
  currentPolicy,
  inspectTask,
  publicKey,
  taskId,
  type Selected,
} from './task-lock-inspect.js';

export const TASK_PAGE_SIZE = 64;
export const MAX_TASK_CATALOG_ENTRIES = 8192;
const MAX_NAME_BYTES = 1024 * 1024;
export interface TaskCatalog {
  root: Location;
  key: Awaited<ReturnType<typeof publicKey>>;
  policy: string | null;
  names: string[];
  sha256: string;
  limited: boolean;
  snapshot: FilePin | null;
}
async function snapshot(root: Location): Promise<FilePin | null> {
  const path = join(root.home, 'tasks');
  if (!same(await directory(path, true), root.tasksPin)) fail('task-page-stale');
  if (root.tasksPin === null) return null;
  const info = await lstat(path, { bigint: true });
  const captured = filePin(info);
  if (
    !info.isDirectory() ||
    !same(
      { dev: captured.dev, ino: captured.ino, uid: captured.uid, mode: captured.mode },
      root.tasksPin,
    )
  )
    fail('task-page-stale');
  return captured;
}

/** Names only, never permit/key bodies outside the selected page. No descriptor survives a call. */
export async function captureTaskCatalog(
  options: Options,
  afterListing?: () => Promise<void>,
): Promise<TaskCatalog> {
  checkDeadline(options);
  const root = await location(options),
    key = await publicKey(root),
    before = await snapshot(root);
  const names: string[] = [];
  let examined = 0,
    nameBytes = 0,
    limited = false;
  if (before !== null) {
    const entries = await opendir(join(root.home, 'tasks'));
    try {
      for (;;) {
        checkDeadline(options);
        const entry = await entries.read();
        if (entry === null) break;
        if (
          ++examined > MAX_TASK_CATALOG_ENTRIES ||
          (nameBytes += Buffer.byteLength(entry.name)) > MAX_NAME_BYTES
        ) {
          limited = true;
          break;
        }
        if (isTaskId(entry.name)) names.push(entry.name);
      }
    } finally {
      await entries.close();
    }
  }
  names.sort();
  await afterListing?.();
  await assertLocation(options, root);
  if (
    !same(before, await snapshot(root)) ||
    !same(binding(key.source), binding((await publicKey(root)).source))
  )
    fail('task-page-stale');
  const sha256 = hash(
    stableStringify({
      v: 1,
      root,
      directory: before,
      key: binding(key.source),
      names,
      limited,
      workspaceId: options.workspaceId,
      runtimeSha256: options.runtimeSha256,
    }),
  );
  return { root, key, policy: await currentPolicy(root), names, sha256, limited, snapshot: before };
}

/** A cursor binds listing/root/key/runtime; permit bodies and terminal markers are freshly read. */
export async function assertTaskCatalog(options: Options, catalog: TaskCatalog): Promise<void> {
  checkDeadline(options);
  await assertLocation(options, catalog.root);
  if (
    !same(await snapshot(catalog.root), catalog.snapshot) ||
    !same(binding((await publicKey(catalog.root)).source), binding(catalog.key.source))
  )
    fail('task-page-stale');
}

export function nativeTaskForId(catalog: TaskCatalog, workspaceId: string, id: string): string {
  const raw = catalog.names.find((name) => taskId(workspaceId, name) === id);
  if (raw === undefined) fail(catalog.limited ? 'task-lookup-limit' : 'task-unavailable');
  return raw;
}

export async function captureTaskPage(
  options: Options,
  checkedAt: string,
  catalog: TaskCatalog,
  offset: number,
) {
  const selected: Selected[] = [],
    references = new Map<string, 'foreign' | 'invalid'>();
  let unverified = 0,
    foreign = 0,
    limited = catalog.limited || offset > 0 || offset + TASK_PAGE_SIZE < catalog.names.length;
  for (const raw of catalog.names.slice(offset, offset + TASK_PAGE_SIZE)) {
    checkDeadline(options);
    try {
      const found = await inspectTask(
        raw,
        catalog.root,
        catalog.key.key,
        options,
        checkedAt,
        catalog.policy,
      );
      if (found.kind === 'foreign') {
        foreign++;
        references.set(raw, 'foreign');
      } else if (found.kind === 'invalid') {
        unverified++;
        references.set(raw, 'invalid');
      } else selected.push(found.value);
    } catch (error) {
      if (error instanceof Error && error.message === 'source-limit') limited = true;
      unverified++;
      references.set(raw, 'invalid');
    }
  }
  await assertTaskCatalog(options, catalog);
  return {
    root: catalog.root,
    key: catalog.key,
    policy: catalog.policy,
    selected,
    references,
    catalog,
    coverage: { complete: !limited && unverified === 0, limited, unverified, foreign },
  };
}

/** Resolve an opaque public ID by bounded name hashing, then open ONLY its authenticated permit. */
export async function captureSelectedTask(
  options: Options,
  checkedAt: string,
  id: string,
  expectedSha256: string | null,
) {
  const catalog = await captureTaskCatalog(options),
    raw = nativeTaskForId(catalog, options.workspaceId, id);
  const found = await inspectTask(
    raw,
    catalog.root,
    catalog.key.key,
    options,
    checkedAt,
    catalog.policy,
  );
  if (found.kind !== 'selected') fail('task-unavailable');
  if (expectedSha256 !== null && found.value.row.permitSha256 !== expectedSha256)
    fail('preview-stale');
  await assertTaskCatalog(options, catalog);
  return { ...catalog, catalog, selected: found.value };
}

/** A verified journal already supplies a bounded native ID; unrelated archives grant no authority. */
export async function captureKnownTask(options: Options, checkedAt: string, rawId: string) {
  checkDeadline(options);
  if (!isTaskId(rawId) || rawId === 'invalid') fail('task-unavailable');
  const root = await location(options),
    key = await publicKey(root),
    policy = await currentPolicy(root);
  const selected: Selected[] = [],
    references = new Map<string, 'foreign' | 'invalid'>();
  try {
    const found = await inspectTask(rawId, root, key.key, options, checkedAt, policy);
    if (found.kind === 'selected') selected.push(found.value);
    else references.set(rawId, found.kind);
  } catch {
    references.set(rawId, 'invalid');
  }
  checkDeadline(options);
  await assertLocation(options, root);
  if (!same(binding((await publicKey(root)).source), binding(key.source))) fail('preview-stale');
  return { root, key, policy, selected, references };
}
