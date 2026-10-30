import { join } from 'node:path';
import {
  artifactOf,
  captureSkill,
  findSource,
  type Root,
  type Scope,
} from './skill-quarantine-capture.ts';
import { manifestSource, payloadRestoreBlock, recordEvidence } from './skill-quarantine-vault.ts';
import {
  assertSourceParents,
  inspectSourceParents,
  quarantineEligibility,
  sourceFolder,
  type SourceParents,
  type SourceSelection,
} from './skill-quarantine-source.ts';
import type { Context, vaults } from './skill-quarantine-operations.ts';

export type SkillPlanRequest =
  | { action: 'quarantine'; id: string; expectedSha256: string }
  | { action: 'restore'; recordId: string };
export type Plan = SourceSelection & {
  action: 'quarantine' | 'restore';
  recordId: string;
  scope: Scope;
  name: string;
  root: Root;
  sha256: string;
  files: number;
  bytes: number;
  sourceIdentity: { ino: number; dev: number } | null;
  sourceSha256: string;
  sourceParents: SourceParents;
  manifestSha: string | null;
  artifact: ReturnType<typeof artifactOf>;
  createdAt: string;
};
export async function prepareSkillPlan(
  ctx: Context,
  state: Awaited<ReturnType<typeof vaults>>,
  input: SkillPlanRequest,
  recordId: string,
  createdAt: string,
) {
  if (state.project.gaps.length || state.user.gaps.length)
    throw new Error('quarantine-unavailable');
  if (input.action === 'quarantine') {
    const selected = await findSource(ctx.roots, input.id, ctx.deadline);
    if (state[selected.scope].count >= 32) throw new Error('quarantine-full');
    const sourceParents = await inspectSourceParents(
      selected.root,
      selected.scope,
      selected,
      ctx.deadline,
    );
    const captured = await captureSkill(selected.root, selected.path, ctx.deadline);
    if (
      (await quarantineEligibility(
        sourceFolder(selected.root, selected.scope, selected.skillSource),
        selected.locator,
        captured.tree.entries,
        ctx.deadline,
      )) !== 'supported'
    )
      throw new Error('quarantine-unsupported');
    await assertSourceParents(selected.root, selected.scope, selected, sourceParents, ctx.deadline);
    if (captured.sha256 !== input.expectedSha256) throw new Error('quarantine-conflict');
    return {
      action: input.action,
      recordId,
      scope: selected.scope,
      name: selected.name,
      skillSource: selected.skillSource,
      locator: selected.locator,
      root: selected.root,
      sha256: captured.sha256,
      files: captured.files,
      bytes: captured.bytes,
      sourceIdentity: captured.identity,
      sourceSha256: captured.sourceSha256,
      sourceParents,
      manifestSha: null,
      artifact: artifactOf(
        selected.scope,
        selected.name,
        captured.sha256,
        selected.skillSource,
        selected.locator,
      ),
      createdAt,
    } satisfies Plan;
  }
  const record = [...state.project.located, ...state.user.located].find(
    (record) => record.manifest.id === input.recordId,
  );
  if (!record) throw new Error('quarantine-conflict');
  const selected = manifestSource(record.manifest);
  const evidence = await recordEvidence(record, ctx.deadline);
  if (
    evidence.status !== 'quarantined' &&
    !(
      evidence.status === 'recovery-required' &&
      evidence.original === 'absent' &&
      evidence.payload === 'match'
    )
  )
    throw new Error(
      evidence.status === 'recovery-required'
        ? 'quarantine-recovery-required'
        : 'quarantine-conflict',
    );
  const payload = await captureSkill(record.root, join(record.directory, 'payload'), ctx.deadline);
  if (payloadRestoreBlock(payload.tree.entries)) throw new Error('quarantine-unsupported');
  const sourceParents = await inspectSourceParents(
    record.root,
    record.manifest.scope,
    selected,
    ctx.deadline,
    true,
  );
  return {
    action: input.action,
    recordId: input.recordId,
    scope: record.manifest.scope,
    name: record.manifest.name,
    ...selected,
    root: record.root,
    sha256: record.manifest.artifact.sha256,
    files: record.manifest.files,
    bytes: record.manifest.bytes,
    sourceIdentity: null,
    sourceSha256: payload.sourceSha256,
    sourceParents,
    manifestSha: record.manifestSha,
    artifact: artifactOf(
      record.manifest.scope,
      record.manifest.name,
      record.manifest.artifact.sha256,
      selected.skillSource,
      selected.locator,
    ),
    createdAt: record.manifest.createdAt,
  } satisfies Plan;
}
