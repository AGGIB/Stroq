import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stableStringify } from '@stroq/core';
import type { InventoryEvidence } from '../lib/inventory-evidence.ts';
import type { InventorySignalBinding } from '../lib/inventory-signal-decision.ts';
import { skillSourceOf } from '../lib/skill-sources.ts';

export const signalHash = (value: unknown) =>
  createHash('sha256').update(stableStringify(value)).digest('hex');
export const validSignalSha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
type Pin = {
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};
const pin = (stat: Pin) => ({
  dev: stat.dev,
  ino: stat.ino,
  mode: stat.mode,
  uid: stat.uid,
  nlink: stat.nlink,
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
});

/** Context is private; only its digest is retained in the decision store. */
export async function inventorySignalContext(project: string, userHome: string, home: string) {
  const anchor = async (path: string) => {
    const canonical = await realpath(path);
    const stat = await lstat(canonical);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('signal-store-unavailable');
    return { path: canonical, dev: stat.dev, ino: stat.ino };
  };
  const projectRoot = await anchor(project),
    userRoot = await anchor(userHome);
  return signalHash({ project: projectRoot, user: userRoot, home: resolve(home) });
}

/** Reuses the captured directory/file stats; no second tree read or file-stat pass. */
export function inventorySignalSource(directory: Pin, files: { path: string; stat: Pin }[]) {
  return signalHash({
    directory: pin(directory),
    files: files.map((file) => ({
      pathSha256: signalHash(file.path),
      ...pin(file.stat),
    })),
  });
}

export function inventorySignalAnalysis(
  runtimeSha256: string,
  artifactSha256: string,
  engine: InventoryEvidence['engine'],
  scan: InventoryEvidence['scan'],
  capabilities: InventoryEvidence['capabilities'],
) {
  if (!validSignalSha(runtimeSha256)) throw new Error('signal-store-unavailable');
  return signalHash({
    runtimeSha256,
    artifactSha256,
    engine,
    scan,
    capabilities: [...capabilities].sort((a, b) => a.kind.localeCompare(b.kind)),
  });
}

export function inventorySignalBinding(
  evidence: Pick<
    InventoryEvidence,
    'workspaceId' | 'artifact' | 'engine' | 'scan' | 'capabilities'
  >,
  sourceSha256: string,
  runtimeSha256: string,
): InventorySignalBinding {
  const skillSource = skillSourceOf(evidence.artifact);
  if (
    evidence.artifact.kind !== 'skill' ||
    !skillSource ||
    evidence.artifact.agent === 'claude-desktop'
  )
    throw new Error('signal-conflict');
  return {
    workspaceId: evidence.workspaceId,
    itemId: evidence.artifact.id,
    agent: evidence.artifact.agent,
    skillSource,
    scope: evidence.artifact.scope,
    artifactSha256: evidence.artifact.sha256,
    sourceSha256,
    analysisSha256: inventorySignalAnalysis(
      runtimeSha256,
      evidence.artifact.sha256,
      evidence.engine,
      evidence.scan,
      evidence.capabilities,
    ),
  };
}
