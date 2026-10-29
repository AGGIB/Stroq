import { type KeyObject } from 'node:crypto';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { escalationIdentity, SignedEscalationSchema, verifyEscalation } from '@stroq/core';
import { parseStrictJson } from '../../packages/core/src/scope/strict-json.js';
import {
  TASK_ACCESS_LIMITATIONS,
  validateTaskAccessState,
  type TaskAccessPermission,
  type TaskAccessState,
} from '../lib/task-access.js';
import {
  assertLocation,
  binding,
  checkDeadline,
  directory,
  fail,
  file,
  filePin,
  marker,
  same,
  type Location,
  type Options,
  type Pin,
} from './task-lock-files.js';
import { inspectTask, publicKey, selectedBinding, type Selected } from './task-lock-inspect.js';
import { captureSelectedTask } from './task-lock-catalog.js';

const fingerprint = /^[a-f0-9]{64}$/;
export async function extensionsDirectory(root: Location, selected: Selected): Promise<Pin | null> {
  const found = await directory(join(root.home, 'tasks', selected.rawId, 'extensions'), true);
  if (found !== null && (Number(found.mode) & 0o777) !== 0o700) fail('permission-unavailable');
  return found;
}
export async function assertUnusedSlot(
  root: Location,
  selected: Selected,
  fp: string,
): Promise<Pin | null> {
  if (!fingerprint.test(fp)) fail('refusal-unavailable');
  const dir = await extensionsDirectory(root, selected);
  if (
    dir !== null &&
    (await marker(join(root.home, 'tasks', selected.rawId, 'extensions', `${fp}.json`))).kind !==
      'missing'
  )
    fail('permission-active');
  if (dir !== null) {
    const entries = await opendir(join(root.home, 'tasks', selected.rawId, 'extensions'));
    let examined = 0;
    try {
      for (;;) {
        const entry = await entries.read();
        if (entry === null) break;
        if (++examined > 256 || (entry.name.startsWith(`${fp}.`) && entry.name.endsWith('.used')))
          fail('permission-unavailable');
      }
    } finally {
      await entries.close();
    }
  }
  return dir;
}
export async function safeUsed(path: string): Promise<'missing' | 'consumed'> {
  try {
    const found = await file(path, 0);
    if (found.kind === 'missing') return 'missing';
    if ((Number(found.pin.mode) & 0o777) !== 0o600) fail('permission-unavailable');
    return 'consumed';
  } catch {
    fail('permission-unavailable');
  }
}
export async function permissionRow(
  root: Location,
  selected: Selected,
  key: KeyObject,
  fp: string,
  checkedAt: string,
): Promise<{ row: TaskAccessPermission; usedName: string | null }> {
  const path = join(root.home, 'tasks', selected.rawId, 'extensions');
  const invalid = (sha: string | null) => ({
    row: {
      fingerprint: fp,
      extensionSha256: sha,
      issuedAt: null,
      expiresAt: null,
      state: 'invalid' as const,
    },
    usedName: null,
  });
  let source;
  try {
    source = await file(join(path, `${fp}.json`), 16384);
  } catch {
    return invalid(null);
  }
  if (source.kind !== 'file') return invalid(null);
  if ((Number(source.pin.mode) & 0o777) !== 0o600) return invalid(source.sha256);
  const parsed = parseStrictJson(source.text),
    signed = parsed.ok ? SignedEscalationSchema.safeParse(parsed.value) : null;
  if (!signed?.success) return invalid(source.sha256);
  const body = selected.signed.body,
    extension = signed.data.body;
  const verified = verifyEscalation(source.text, key, {
    now: new Date(extension.issuedAt),
    taskId: selected.rawId,
    nonce: body.nonce,
    fingerprint: fp,
  });
  if (
    !verified.ok ||
    Date.parse(extension.expiresAt) > Date.parse(body.expiresAt) ||
    Date.parse(extension.issuedAt) > Date.parse(checkedAt) + 60000
  )
    return invalid(source.sha256);
  const usedName = `${fp}.${escalationIdentity(source.text)}.used`;
  let used;
  try {
    used = await safeUsed(join(path, usedName));
  } catch {
    return invalid(source.sha256);
  }
  return {
    row: {
      fingerprint: fp,
      extensionSha256: source.sha256,
      issuedAt: extension.issuedAt,
      expiresAt: extension.expiresAt,
      state:
        used === 'consumed' ? 'consumed' : extension.expiresAt <= checkedAt ? 'expired' : 'unused',
    },
    usedName,
  };
}

/** Current, bounded extension files; unused is a consumption state, never proof of active access. */
export async function accessState(
  input: Record<string, unknown>,
  options: Options,
): Promise<TaskAccessState> {
  if (
    Object.keys(input).sort().join(',') !== 'expectedPermitSha256,id' ||
    typeof input.id !== 'string' ||
    !/^task-[a-f0-9]{64}$/.test(input.id) ||
    typeof input.expectedPermitSha256 !== 'string' ||
    !fingerprint.test(input.expectedPermitSha256)
  )
    fail('task-unavailable');
  const checkedAt = options.now ?? new Date().toISOString();
  const capture = await captureSelectedTask(
    options,
    checkedAt,
    input.id,
    input.expectedPermitSha256 as string,
  );
  const { root, key, policy, selected } = capture;
  if (key.key === null) fail('task-unavailable');
  const dirPin = await extensionsDirectory(root, selected),
    permissions: TaskAccessPermission[] = [];
  let limited = false,
    unverified = 0;
  if (dirPin !== null) {
    const dirPath = join(root.home, 'tasks', selected.rawId, 'extensions'),
      names: string[] = [];
    const before = filePin(await lstat(dirPath, { bigint: true }));
    const dir = await opendir(dirPath);
    try {
      for (;;) {
        checkDeadline(options);
        const entry = await dir.read();
        if (entry === null) break;
        if (names.length === 256) {
          limited = true;
          break;
        }
        names.push(entry.name);
      }
    } finally {
      await dir.close();
    }
    const recognized = new Set<string>();
    for (const name of names.sort()) {
      const match = /^([a-f0-9]{64})\.json$/.exec(name);
      if (!match) continue;
      if (permissions.length === 64) {
        limited = true;
        break;
      }
      const result = await permissionRow(root, selected, key.key, match[1]!, checkedAt);
      permissions.push(result.row);
      recognized.add(name);
      if (result.usedName !== null) recognized.add(result.usedName);
      if (result.row.state === 'invalid') unverified++;
    }
    for (const name of names) if (!recognized.has(name)) unverified++;
    if (
      !same(await extensionsDirectory(root, selected), dirPin) ||
      !same(filePin(await lstat(dirPath, { bigint: true })), before)
    )
      fail('preview-stale');
  }
  await assertLocation(options, root);
  const lastKey = await publicKey(root),
    last = await inspectTask(selected.rawId, root, lastKey.key, options, checkedAt, policy);
  if (
    !same(binding(lastKey.source), binding(key.source)) ||
    last.kind !== 'selected' ||
    !same(selectedBinding(last.value), selectedBinding(selected))
  )
    fail('preview-stale');
  const result: TaskAccessState = {
    schema: 'stroq-task-access/1',
    workspaceId: options.workspaceId,
    taskId: selected.row.id,
    permitSha256: selected.row.permitSha256,
    checkedAt,
    coverage: { complete: !limited && unverified === 0, limited, unverified },
    permissions,
    limitations: TASK_ACCESS_LIMITATIONS,
  };
  if (!validateTaskAccessState(result)) fail('invalid-report');
  return result;
}
