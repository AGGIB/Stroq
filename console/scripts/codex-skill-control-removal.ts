import { mkdir, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { rootIdentity, snapshotFile, assertUnchanged } from './agent-setup-files.mjs';
import {
  CONFIG_BYTES,
  controlParents,
  fail,
  owned,
  publishedPin,
  same,
  sourceSnapshot,
  type ControlOptions,
  type ControlPrivatePlan,
  type ControlRecord,
} from './codex-skill-control-binding.ts';
import {
  saveControlManifest,
  getControlRecord,
  syncControlDirectory,
} from './codex-skill-control-store.ts';
import type { ControlHooks } from './codex-skill-control-transaction.ts';
/** Move into a new private same-filesystem holder before inspecting/removing an exact owned inode. */
export async function removeCodexSkillConfigToAbsence(
  _options: ControlOptions,
  plan: ControlPrivatePlan,
  initial: ControlRecord,
  guard: () => Promise<void>,
  hooks: ControlHooks,
) {
  let record = initial;
  const intent = record.manifest.removal;
  if (!intent || !plan.before.file || plan.preview.afterSha256 !== null)
    fail('codex-control-stale');
  await guard();
  await assertUnchanged(plan.context.user, plan.context.target, plan.before);
  await mkdir(intent.directory, { mode: 0o700 });
  const holder = await rootIdentity(intent.directory);
  if (holder.path !== intent.directory || !owned(holder) || (holder.mode & 0o777) !== 0o700)
    fail('codex-control-write-unconfirmed');
  const manifest = {
    ...record.manifest,
    updatedAt: new Date().toISOString(),
    removal: { ...intent, directoryPin: holder },
  };
  const revision = await saveControlManifest(plan.context, manifest, record.revision, async () => {
    await guard();
    await assertUnchanged(plan.context.user, plan.context.target, plan.before);
    if (!same(await rootIdentity(intent.directory), holder))
      fail('codex-control-write-unconfirmed');
  });
  record = await getControlRecord(plan.context, manifest.id, revision);
  const temporary = join(holder.path, 'config.toml'),
    missing = await snapshotFile(holder, temporary, CONFIG_BYTES);
  if (missing.bytes !== null) fail('codex-control-write-unconfirmed');
  await guard();
  await assertUnchanged(plan.context.user, plan.context.target, plan.before);
  await hooks.fault?.('before-removal-rename');
  // No copy fallback: EXDEV or contradictory readback preserves the current files and durable intent.
  await rename(plan.context.target, temporary);
  await syncControlDirectory(dirname(plan.context.target));
  await syncControlDirectory(holder.path);
  const moved = await snapshotFile(holder, temporary, CONFIG_BYTES),
    current = await sourceSnapshot(plan.context);
  if (
    !moved.file ||
    moved.sha256 !== plan.preview.beforeSha256 ||
    !same(publishedPin(moved.file), publishedPin(plan.before.file)) ||
    current.bytes !== null ||
    !same(controlParents(current), record.manifest.parents)
  )
    fail('codex-control-write-unconfirmed');
  const published = {
    ...record.manifest,
    updatedAt: new Date().toISOString(),
    removal: { ...record.manifest.removal!, moved: moved.file },
  };
  const next = await saveControlManifest(plan.context, published, record.revision, async () => {
    await guard();
    await assertUnchanged(holder, temporary, moved);
    await assertUnchanged(plan.context.user, plan.context.target, current);
  });
  record = await getControlRecord(plan.context, published.id, next);
  await hooks.fault?.('after-target-rename');
  await guard();
  await assertUnchanged(plan.context.user, plan.context.target, current);
  await assertUnchanged(holder, temporary, moved);
  await unlink(temporary);
  await syncControlDirectory(holder.path);
  if ((await snapshotFile(holder, temporary, CONFIG_BYTES)).bytes !== null)
    fail('codex-control-write-unconfirmed');
  if (!same(await rootIdentity(holder.path), holder)) fail('codex-control-write-unconfirmed');
  await rmdir(holder.path);
  await syncControlDirectory(dirname(plan.context.target));
  return record;
}
