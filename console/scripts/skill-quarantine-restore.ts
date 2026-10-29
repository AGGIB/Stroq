import { constants } from 'node:fs';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Tree } from '../../packages/cli/src/install/types.ts';
import type { Root, Scope } from './skill-quarantine-capture.ts';
import { checkDeadline, inspectLocation, sameIdentity } from './skill-quarantine-paths.mjs';
import { inject, type Fault } from './skill-quarantine-faults.ts';
import {
  assertSourceParents,
  restoreSourceParents,
  type SourceParents,
  type SourceSelection,
} from './skill-quarantine-source.ts';
/** Node rename can overwrite a directory. Publish a restore exclusively, with SKILL.md last. */
export async function materialize(
  root: Root,
  folder: string,
  recordDirectory: string,
  tree: Tree,
  directories: string[],
  deadline: number,
  fault: Fault,
  source: { scope: Scope; selected: SourceSelection; parents: SourceParents },
  commitGuard?: (strong?: boolean) => Promise<void>,
) {
  await commitGuard?.(false);
  const sourceParents = await restoreSourceParents(
    root,
    source.scope,
    source.selected,
    source.parents,
    deadline,
    commitGuard,
  );
  await commitGuard?.(false);
  await mkdir(folder, { mode: 0o700 });
  const created = new Map<string, { ino: number; dev: number }>();
  const rememberCreated = async (path: string) => {
    const directory = await inspectLocation(root, path);
    if (!directory) throw new Error('quarantine-recovery-required');
    created.set(path, { ino: directory.ino, dev: directory.dev });
  };
  await rememberCreated(folder);
  const assertCreated = async () => {
    await assertSourceParents(root, source.scope, source.selected, sourceParents, deadline);
    for (const [path, id] of created)
      if (!sameIdentity(id, await inspectLocation(root, path)))
        throw new Error('quarantine-recovery-required');
  };
  for (const directory of [...directories].sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
  )) {
    checkDeadline(deadline);
    await assertCreated();
    const path = join(folder, directory);
    await commitGuard?.(false);
    await mkdir(path, { mode: 0o700 });
    await rememberCreated(path);
  }
  const entries = [...tree.entries].sort((a, b) =>
    a.path === 'SKILL.md' ? 1 : b.path === 'SKILL.md' ? -1 : a.path.localeCompare(b.path),
  );
  for (const entry of entries) {
    checkDeadline(deadline);
    await assertCreated();
    if (entry.path === 'SKILL.md') await inject(fault, 'restore-before-skill');
    let at = folder;
    for (const part of entry.path.split('/').slice(0, -1)) {
      at = join(at, part);
      if (!created.has(at)) {
        await commitGuard?.(false);
        await mkdir(at, { mode: 0o700 });
        await rememberCreated(at);
      }
    }
    const path = join(folder, entry.path);
    const staged =
      entry.path === 'SKILL.md' ? join(recordDirectory, `.restore-${randomUUID()}.tmp`) : path;
    await assertCreated();
    await commitGuard?.(false);
    const handle = await open(
      staged,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      entry.exec ? 0o700 : 0o600,
    );
    try {
      await handle.writeFile(entry.bytes!);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (entry.path === 'SKILL.md') {
      // An exclusive hard link publishes complete bytes atomically; rename lacks NOREPLACE.
      const stagedIdentity = await inspectLocation(root, staged, 'file', true);
      await assertCreated();
      await inspectLocation(root, recordDirectory, 'directory', true);
      await commitGuard?.();
      await link(staged, path);
      if (!sameIdentity(stagedIdentity, await handleIdentity(staged)))
        throw new Error('quarantine-recovery-required');
      await unlink(staged);
    }
  }
  await assertCreated();
}
async function handleIdentity(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    return await handle.stat();
  } finally {
    await handle.close();
  }
}
