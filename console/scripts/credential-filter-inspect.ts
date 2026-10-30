import { lstat } from 'node:fs/promises';
import { prepare } from '../../packages/cli/src/commands/harden-plan.ts';
import { findRecipe } from '../../packages/cli/src/harden/recipes/index.ts';
import {
  CLAUDE_READ_DENY_RULES,
  PROJECT_SECRET_FILES,
} from '../../packages/cli/src/harden/recipes/credential-paths.ts';
import {
  entriesFor,
  readManifestSnapshot,
  type ManifestEntry,
} from '../../packages/cli/src/harden/manifest.ts';
import { parseJsonDocument, isObject } from '../../packages/cli/src/harden/json-doc.ts';
import { blockMarkers, findBlock, rowsOf } from '../../packages/cli/src/harden/textblock-find.ts';
import { readTargetSnapshot } from '../../packages/cli/src/harden/read.ts';
import type { HardenEnv } from '../../packages/cli/src/harden/types.ts';
import {
  CREDENTIAL_FILTER_REASONS,
  type CredentialFilterRow,
  type CredentialFilterReason,
} from '../lib/credential-filters.ts';
import { inspectPath } from './agent-setup-files.mjs';
import { directory, hash } from './credential-filter-targets.mjs';
import type { CredentialTarget, CredentialResolution } from './credential-filter-types.ts';

export const MAX_FILTER_SOURCE = 256 * 1024;
export function safeError(error: unknown): CredentialFilterReason {
  const code = (error as { code?: string }).code,
    message = (error as Error).message;
  if (typeof message === 'string' && Object.hasOwn(CREDENTIAL_FILTER_REASONS, message))
    return message as CredentialFilterReason;
  if (code?.startsWith('manifest-')) return 'credential-filter-storage-unavailable';
  if (code === 'stale-plan') return 'credential-filter-preview-stale';
  if (code === 'target-too-large') return 'credential-filter-source-limit';
  if (['not-utf8', 'lossy-json', 'plan-refused', 'plan-inconsistent'].includes(code ?? ''))
    return 'credential-filter-source-invalid';
  if (
    [
      'path-escapes-root',
      'path-changed',
      'dangling-link',
      'not-regular-file',
      'read-only-target',
    ].includes(code ?? '') ||
    message === 'unsafe-config'
  )
    return 'credential-filter-source-unsafe';
  return 'credential-filter-unavailable';
}
export async function guardSource(target: CredentialTarget) {
  const root = await directory(target.root);
  const rootStat = await lstat(root.path);
  if (String(rootStat.dev) !== root.dev || String(rootStat.ino) !== root.ino)
    throw new Error('credential-filter-source-unsafe');
  const found = await inspectPath(
    {
      path: root.path,
      dev: rootStat.dev,
      ino: rootStat.ino,
      uid: rootStat.uid,
      mode: rootStat.mode,
    },
    target.file,
  );
  if (found.exists) {
    const s = await lstat(target.file);
    if ((typeof process.getuid === 'function' && s.uid !== process.getuid()) || !(s.mode & 0o200))
      throw new Error('credential-filter-source-unsafe');
    if (s.size > MAX_FILTER_SOURCE) throw new Error('credential-filter-source-limit');
  }
}
export function fixedItems(target: CredentialTarget): readonly string[] {
  return target.agent === 'cursor' ? PROJECT_SECRET_FILES : CLAUDE_READ_DENY_RULES;
}
export function presentItems(
  target: CredentialTarget,
  text: string,
): { present: Set<string>; managedBlock: boolean; reason: CredentialFilterReason | null } {
  const items = fixedItems(target);
  if (target.agent !== 'cursor') {
    const parsed = parseJsonDocument(text);
    if (!parsed.ok)
      return {
        present: new Set(),
        managedBlock: false,
        reason: 'credential-filter-source-invalid',
      };
    const permissions = parsed.doc.permissions;
    if (
      (permissions !== undefined && !isObject(permissions)) ||
      (isObject(permissions) && permissions.deny !== undefined && !Array.isArray(permissions.deny))
    )
      return {
        present: new Set(),
        managedBlock: false,
        reason: 'credential-filter-source-invalid',
      };
    const deny = isObject(permissions) && Array.isArray(permissions.deny) ? permissions.deny : [];
    if (deny.some((value) => typeof value !== 'string'))
      return {
        present: new Set(),
        managedBlock: false,
        reason: 'credential-filter-source-invalid',
      };
    return {
      present: new Set(items.filter((item) => deny.includes(item))),
      managedBlock: false,
      reason: null,
    };
  }
  const markers = blockMarkers('cursor-ignore'),
    found = findBlock(text, 'cursor-ignore');
  const rows = rowsOf(text).map((row, index) =>
    index === 0 ? row.content.replace(/^\uFEFF/, '') : row.content,
  );
  const starts = rows.filter((row) => row.trimEnd() === markers.begin).length;
  const ends = rows.filter((row) => row.trimEnd() === markers.end).length;
  const present = new Set(items.filter((item) => rows.includes(item)));
  if (found.kind === 'none' && !starts && !ends)
    return { present, managedBlock: false, reason: null };
  if (found.kind !== 'found')
    return { present, managedBlock: false, reason: 'credential-filter-edited-block' };
  const canonical =
    starts === 1 &&
    ends === 1 &&
    found.begin.content === markers.begin &&
    found.end.content === markers.end &&
    JSON.stringify(found.body) === JSON.stringify(items);
  return {
    present,
    managedBlock: canonical,
    reason: canonical ? null : 'credential-filter-edited-block',
  };
}
function validHistory(entry: ManifestEntry, target: CredentialTarget) {
  if (entry.recipe !== target.recipe || entry.real !== target.file || entry.root !== target.root)
    return false;
  const fixed = fixedItems(target);
  if (target.agent === 'cursor')
    return (
      entry.edits.length === 1 &&
      entry.edits.every(
        (edit) =>
          edit.kind === 'text-block' &&
          edit.id === 'cursor-ignore' &&
          edit.previous === null &&
          JSON.stringify(edit.lines) === JSON.stringify(fixed),
      )
    );
  return (
    entry.edits.length === fixed.length &&
    new Set(entry.edits.map((edit) => (edit.kind === 'json-array-add' ? edit.value : null)))
      .size === fixed.length &&
    entry.edits.every(
      (edit) =>
        edit.kind === 'json-array-add' &&
        JSON.stringify(edit.path) === '["permissions","deny"]' &&
        typeof edit.value === 'string' &&
        fixed.includes(edit.value),
    )
  );
}
export function history(env: HardenEnv, target: CredentialTarget) {
  const snapshot = readManifestSnapshot(env),
    entries = entriesFor(snapshot.manifest, target.file);
  if (entries.some((entry) => !validHistory(entry, target)))
    throw new Error('credential-filter-mixed-history');
  return entries;
}
export async function inspectFilter(
  target: CredentialTarget,
  resolved: CredentialResolution,
  env: HardenEnv,
) {
  if (target.reason) throw new Error(target.reason);
  await guardSource(target);
  const raw = readTargetSnapshot(target.file, MAX_FILTER_SOURCE);
  const recipe = findRecipe(target.recipe);
  if (!recipe) throw new Error('credential-filter-unsupported-source');
  const made = prepare(
    {
      cwd: target.root,
      home: resolved.roots.user.path,
      claudeConfigDir: undefined,
      env,
      askable: async () => null,
    },
    recipe,
    target.scope,
    false,
  );
  if (made.target.file !== target.file || made.plan.real !== target.file)
    throw new Error('credential-filter-source-unsafe');
  if (
    Buffer.byteLength(made.plan.before) > MAX_FILTER_SOURCE ||
    Buffer.byteLength(made.plan.after) > MAX_FILTER_SOURCE
  )
    throw new Error('credential-filter-source-limit');
  const after = readTargetSnapshot(target.file, MAX_FILTER_SOURCE);
  if (
    JSON.stringify(raw.identity) !== JSON.stringify(after.identity) ||
    (raw.bytes === null
      ? after.bytes !== null
      : after.bytes === null || !raw.bytes.equals(after.bytes))
  )
    throw new Error('credential-filter-preview-stale');
  const inspected = presentItems(target, made.plan.before);
  const reason =
    inspected.reason ?? (made.plan.refused ? ('credential-filter-source-invalid' as const) : null);
  const sourceSha256 = raw.bytes === null ? null : hash(raw.bytes);
  let entries: readonly ManifestEntry[] = [],
    storageReason: CredentialFilterReason | null = null;
  try {
    entries = history(env, target);
  } catch (error) {
    storageReason = safeError(error);
  }
  const managedItems = new Set(
    entries.flatMap((entry) =>
      entry.edits.flatMap((edit) =>
        edit.kind === 'json-array-add'
          ? !edit.preexisting && typeof edit.value === 'string' && inspected.present.has(edit.value)
            ? [edit.value]
            : []
          : edit.kind === 'text-block' && inspected.managedBlock
            ? fixedItems(target).filter((item) => inspected.present.has(item))
            : [],
      ),
    ),
  );
  const present = inspected.present.size,
    known = storageReason === null;
  const row: CredentialFilterRow = {
    id: target.id,
    recipe: target.recipe,
    agent: target.agent,
    scope: target.scope,
    target: target.target,
    location: target.location,
    context: target.context,
    status: reason
      ? 'unavailable'
      : present === target.required
        ? 'configured'
        : present
          ? 'partial'
          : 'absent',
    exists: raw.bytes !== null,
    sourceSha256,
    bytes: raw.bytes?.length ?? 0,
    required: target.required,
    present,
    managed: known ? managedItems.size : null,
    unmanaged: known ? present - managedItems.size : null,
    applications: known ? entries.length : null,
    undoAvailable: known && !reason && entries.length > 0,
    reason: reason ?? storageReason,
  };
  return { target, made, row, entries };
}
export function unavailableRow(
  target: Pick<
    CredentialTarget,
    'id' | 'recipe' | 'agent' | 'scope' | 'target' | 'location' | 'context' | 'required'
  >,
  reason: CredentialFilterReason,
): CredentialFilterRow {
  return {
    id: target.id,
    recipe: target.recipe,
    agent: target.agent,
    scope: target.scope,
    target: target.target,
    location: target.location,
    context: target.context,
    status: 'unavailable',
    exists: false,
    sourceSha256: null,
    bytes: 0,
    required: target.required,
    present: 0,
    managed: null,
    unmanaged: null,
    applications: null,
    undoAvailable: false,
    reason,
  };
}
