import { lstat, opendir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { SKILL_QUARANTINE_LIMITATIONS } from '../lib/skill-quarantine.ts';
import { isSkillSourceId } from '../lib/skill-sources.ts';
import { captureSkill, validName, type Root, type Scope } from './skill-quarantine-capture.ts';
import { safeInventoryName, skillArtifactId, validSkillLocator } from './skill-sources.ts';
import {
  inspectSourceParents,
  publicArtifact,
  selectedPath,
  type SourceSelection,
} from './skill-quarantine-source.ts';
import {
  checkDeadline,
  hash,
  inspectLocation,
  readPrivateBytes,
  readPrivateJson,
} from './skill-quarantine-paths.mjs';

export const LIMITATIONS = SKILL_QUARANTINE_LIMITATIONS;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
type ManifestBase = {
  id: string;
  name: string;
  scope: Scope;
  createdAt: string;
  restoredAt: string | null;
  phase: 'prepared' | 'quarantined' | 'restoring' | 'restored';
  files: number;
  bytes: number;
  rootBinding: string;
};
type LegacyArtifact = {
  id: string;
  name: string;
  agent: 'claude-code';
  scope: Scope;
  sha256: string;
};
export type Manifest = ManifestBase &
  (
    | { schema: 'stroq-skill-quarantine-record/1'; artifact: LegacyArtifact }
    | ({
        schema: 'stroq-skill-quarantine-record/2';
        artifact: ReturnType<typeof publicArtifact>;
      } & SourceSelection)
  );
export type LocatedRecord = {
  root: Root;
  directory: string;
  manifestPath: string;
  manifestSha: string;
  manifest: Manifest;
};
export const vaultPath = (root: Root) => join(root.path, '.claude', '.stroq-quarantine');
export const recordPath = (root: Root, id: string) => join(vaultPath(root), id);
const stamp = (value: unknown) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const rootBinding = (root: Root) => hash(`${root.path}\0${root.dev}\0${root.ino}`);
export function manifestSource(manifest: Manifest): SourceSelection {
  return manifest.schema === 'stroq-skill-quarantine-record/1'
    ? { skillSource: 'claude-skills', locator: manifest.name }
    : { skillSource: manifest.skillSource, locator: manifest.locator };
}
function legacyArtifact(scope: Scope, name: string, sha256: string): LegacyArtifact {
  const id = skillArtifactId('claude-skills', scope, name);
  return {
    id,
    name: safeInventoryName(name, `Skill ${id.slice(-8)}`),
    agent: 'claude-code',
    scope,
    sha256,
  };
}
function validManifest(value: unknown, root: Root, scope: Scope, id: string): value is Manifest {
  if (
    !object(value) ||
    !['stroq-skill-quarantine-record/1', 'stroq-skill-quarantine-record/2'].includes(
      String(value.schema),
    ) ||
    value.id !== id ||
    !UUID.test(id) ||
    value.scope !== scope ||
    value.rootBinding !== rootBinding(root) ||
    typeof value.name !== 'string' ||
    !stamp(value.createdAt) ||
    !(value.restoredAt === null || stamp(value.restoredAt)) ||
    !['prepared', 'quarantined', 'restoring', 'restored'].includes(String(value.phase)) ||
    (value.phase === 'restored' ? value.restoredAt === null : value.restoredAt !== null) ||
    !Number.isInteger(value.files) ||
    Number(value.files) < 1 ||
    Number(value.files) > 128 ||
    !Number.isInteger(value.bytes) ||
    Number(value.bytes) < 0 ||
    Number(value.bytes) > 524288 ||
    !object(value.artifact) ||
    typeof value.artifact.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.artifact.sha256)
  )
    return false;
  const baseKeys =
    'artifact,bytes,createdAt,files,id,name,phase,restoredAt,rootBinding,schema,scope';
  if (value.schema === 'stroq-skill-quarantine-record/1')
    return (
      Object.keys(value).sort().join(',') === baseKeys &&
      validName(value.name) &&
      JSON.stringify(value.artifact) ===
        JSON.stringify(legacyArtifact(scope, value.name, value.artifact.sha256))
    );
  if (
    Object.keys(value).sort().join(',') !==
      `${baseKeys},skillSource,locator`.split(',').sort().join(',') ||
    !isSkillSourceId(value.skillSource) ||
    !validSkillLocator(value.locator) ||
    value.name !== basename(value.locator)
  )
    return false;
  return (
    JSON.stringify(value.artifact) ===
    JSON.stringify(
      publicArtifact(
        scope,
        { skillSource: value.skillSource, locator: value.locator },
        value.artifact.sha256,
      ),
    )
  );
}
export async function loadRecord(root: Root, scope: Scope, id: string): Promise<LocatedRecord> {
  if (!UUID.test(id)) throw new Error('quarantine-conflict');
  const directory = recordPath(root, id);
  if (
    !(await inspectLocation(root, vaultPath(root), 'directory', true)) ||
    !(await inspectLocation(root, directory, 'directory', true))
  )
    throw new Error('record-invalid');
  if (
    !(await readPrivateBytes(root, join(vaultPath(root), '.gitignore'))).bytes.equals(
      Buffer.from('*\n'),
    )
  )
    throw new Error('record-invalid');
  const manifestPath = join(directory, 'manifest.json');
  const read = await readPrivateJson(root, manifestPath);
  if (!validManifest(read.value, root, scope, id)) throw new Error('record-invalid');
  return { root, directory, manifestPath, manifestSha: read.sha256, manifest: read.value };
}
async function originalState(record: LocatedRecord, deadline: number) {
  try {
    const selected = manifestSource(record.manifest);
    await inspectSourceParents(record.root, record.manifest.scope, selected, deadline, true);
    const path = selectedPath(record.root, record.manifest.scope, selected);
    // Any ordinary existing object makes restoration unavailable, including an empty directory.
    const stat = await lstat(path).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return 'absent' as const;
    if (stat.isSymbolicLink()) return 'unverifiable' as const;
    if (!stat.isDirectory()) {
      await inspectLocation(record.root, path, 'file');
      return 'different' as const;
    }
    await inspectLocation(record.root, path);
    try {
      const capture = await captureSkill(record.root, path, deadline);
      return capture.sha256 === record.manifest.artifact.sha256
        ? ('same' as const)
        : ('different' as const);
    } catch (error) {
      if ((error as Error).message === 'deadline-exceeded') throw error;
      return 'different' as const;
    }
  } catch (error) {
    if ((error as Error).message === 'deadline-exceeded') throw error;
    return 'unverifiable' as const;
  }
}
export function payloadRestoreBlock(
  entries: readonly { path: string }[],
): 'overlapping-skill' | 'managed-source' | undefined {
  if (entries.some((entry) => entry.path !== 'SKILL.md' && /(?:^|\/)SKILL\.md$/i.test(entry.path)))
    return 'overlapping-skill';
  if (
    entries.some((entry) =>
      /(?:^|\/)(?:\.claude-plugin|plugin\.json|marketplace\.json)(?:\/|$)/i.test(entry.path),
    )
  )
    return 'managed-source';
  return undefined;
}
export async function recordEvidence(record: LocatedRecord, deadline: number) {
  const original = await originalState(record, deadline);
  let payload: 'match' | 'changed' | 'missing' | 'unverifiable' = 'unverifiable';
  let restoreBlock: ReturnType<typeof payloadRestoreBlock>;
  try {
    const path = join(record.directory, 'payload');
    const exists = await inspectLocation(record.root, path);
    if (!exists) payload = 'missing';
    else {
      const capture = await captureSkill(record.root, path, deadline);
      payload =
        capture.sha256 === record.manifest.artifact.sha256 &&
        capture.files === record.manifest.files &&
        capture.bytes === record.manifest.bytes
          ? 'match'
          : 'changed';
      if (payload === 'match') restoreBlock = payloadRestoreBlock(capture.tree.entries);
    }
  } catch (error) {
    if ((error as Error).message === 'deadline-exceeded') throw error;
  }
  const phase = record.manifest.phase;
  const status =
    phase === 'prepared' || phase === 'restoring'
      ? 'recovery-required'
      : payload === 'changed'
        ? 'payload-changed'
        : payload === 'missing'
          ? 'payload-missing'
          : payload === 'unverifiable' || original === 'unverifiable'
            ? 'unverifiable'
            : phase === 'restored'
              ? original === 'same'
                ? 'restored'
                : 'unverifiable'
              : original === 'absent'
                ? 'quarantined'
                : 'reappeared';
  return {
    id: record.manifest.id,
    artifact: publicArtifact(
      record.manifest.scope,
      manifestSource(record.manifest),
      record.manifest.artifact.sha256,
    ),
    createdAt: record.manifest.createdAt,
    restoredAt: record.manifest.restoredAt,
    checkedAt: new Date().toISOString(),
    files: record.manifest.files,
    bytes: record.manifest.bytes,
    status,
    original,
    payload,
    ...(restoreBlock ? { restoreBlock } : {}),
  };
}
export async function readVault(root: Root, scope: Scope, deadline: number) {
  const records: Awaited<ReturnType<typeof recordEvidence>>[] = [];
  const located: LocatedRecord[] = [];
  const gaps: { scope: Scope; code: 'vault-unavailable' | 'vault-limit' | 'record-invalid' }[] = [];
  let names: string[] = [];
  try {
    if (!(await inspectLocation(root, vaultPath(root), 'directory', true)))
      return { records, located, gaps, count: 0 };
    if (
      !(await readPrivateBytes(root, join(vaultPath(root), '.gitignore'))).bytes.equals(
        Buffer.from('*\n'),
      )
    )
      throw new Error('record-invalid');
    const dir = await opendir(vaultPath(root));
    try {
      for await (const entry of dir) {
        checkDeadline(deadline);
        if (entry.name === '.gitignore') continue;
        if (names.length >= 32) {
          gaps.push({ scope, code: 'vault-limit' });
          break;
        }
        names.push(entry.name);
      }
    } finally {
      await dir.close().catch(() => undefined);
    }
  } catch (error) {
    if ((error as Error).message === 'deadline-exceeded') throw error;
    return { records, located, gaps: [{ scope, code: 'vault-unavailable' as const }], count: 32 };
  }
  for (const name of names.sort()) {
    try {
      checkDeadline(deadline);
      const record = await loadRecord(root, scope, name);
      records.push(await recordEvidence(record, deadline));
      located.push(record);
    } catch (error) {
      if ((error as Error).message === 'deadline-exceeded') throw error;
      gaps.push({ scope, code: 'record-invalid' });
    }
  }
  return { records, located, gaps, count: names.length };
}
