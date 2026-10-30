import { readNetworkGuardVault } from './codex-network-guard-store.ts';
import { readPathGuardVault } from './codex-path-guard-store.ts';
import { guardSuperseded } from './codex-network-guard-ownership.ts';
import type { ControlContext, GuardRecord } from './codex-network-guard-binding.ts';
import type { PathGuardRecord } from './codex-path-guard-binding.ts';

/** A selector/subtree owner cannot later deactivate any retained descendant path operation. */
export function networkGuardHasPathDependents(record: GuardRecord, paths: PathGuardRecord[]) {
  const m = record.manifest;
  return (
    m.kind === 'profile-child' &&
    paths.some((p) => p.manifest.target === m.target && p.manifest.profileName === m.childProfile)
  );
}
export function pathGuardHasRestorableNetworkSelector(
  target: string,
  profileName: string,
  network: GuardRecord[],
  paths: PathGuardRecord[] = [],
) {
  return network.some(
    (r) =>
      r.manifest.target === target &&
      r.manifest.kind === 'profile-child' &&
      r.manifest.childProfile === profileName &&
      r.manifest.phase === 'guarded' &&
      !guardSuperseded(r, network) &&
      !networkGuardHasPathDependents(r, paths),
  );
}
export async function assertPathGuardSelectorOwnership(
  context: ControlContext,
  profileName: string,
) {
  let blocked: boolean;
  try {
    const [network, paths] = await Promise.all([
      readNetworkGuardVault(context),
      readPathGuardVault(context),
    ]);
    blocked = pathGuardHasRestorableNetworkSelector(
      context.target,
      profileName,
      network.records,
      paths.records,
    );
  } catch {
    throw Error('codex-path-guard-recovery-required');
  }
  if (blocked) throw Error('codex-path-guard-conflict');
}
export async function networkGuardSupersededByPath(context: ControlContext, record: GuardRecord) {
  try {
    return networkGuardHasPathDependents(record, (await readPathGuardVault(context)).records);
  } catch {
    throw Error('codex-network-recovery-required');
  }
}
export async function assertNetworkGuardRestoreOwnership(
  context: ControlContext,
  record: GuardRecord,
) {
  if (await networkGuardSupersededByPath(context, record)) throw Error('codex-network-superseded');
}
