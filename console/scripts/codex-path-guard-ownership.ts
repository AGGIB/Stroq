import { pathFail, type PathGuardRecord } from './codex-path-guard-binding.ts';
import type { CodexPathGuardOwnership } from './codex-path-guard-toml.ts';
export const pathGuardOwnedKeys = (owned: CodexPathGuardOwnership): string[][] => [
  ['permissions', owned.profileName, 'filesystem', owned.targetPath],
];
const overlap = (a: string[], b: string[]) =>
  a.slice(0, Math.min(a.length, b.length)).every((v, i) => v === b[i]);
export const pathGuardSuperseded = (record: PathGuardRecord, records: PathGuardRecord[]) =>
  records.some(
    (r) =>
      r.manifest.target === record.manifest.target &&
      r.manifest.sequence > record.manifest.sequence &&
      r.manifest.ownedKeys.some((a) => record.manifest.ownedKeys.some((b) => overlap(a, b))),
  );
export function assertPathGuardOwnership(record: PathGuardRecord, records: PathGuardRecord[]) {
  if (pathGuardSuperseded(record, records)) pathFail('codex-path-guard-superseded');
}
