import { parseGuardToml } from './codex-network-guard-parse.ts';
import { networkFail, type GuardRecord } from './codex-network-guard-binding.ts';
import type { CodexNetworkGuardOwnership } from './codex-network-guard-toml.ts';
export function guardOwnedKeys(owned: CodexNetworkGuardOwnership): string[][] {
  if (owned.kind === 'profile-child')
    return [['default_permissions'], ['permissions', owned.childProfile!]];
  if (owned.kind === 'profile-network-off')
    return [
      [
        'permissions',
        parseGuardToml(owned.before).default_permissions as string,
        'network',
        'enabled',
      ],
    ];
  return [
    ...(owned.kind === 'legacy-enable-workspace' ? [['sandbox_mode']] : []),
    ['sandbox_workspace_write', 'network_access'],
  ];
}
const overlap = (a: string[], b: string[]) =>
  a.slice(0, Math.min(a.length, b.length)).every((v, i) => v === b[i]);
export const guardSuperseded = (record: GuardRecord, records: GuardRecord[]) =>
  records.some(
    (r) =>
      r.manifest.target === record.manifest.target &&
      r.manifest.sequence > record.manifest.sequence &&
      r.manifest.ownedKeys.some((a) => record.manifest.ownedKeys.some((b) => overlap(a, b))),
  );
export function assertGuardOwnership(record: GuardRecord, records: GuardRecord[]) {
  if (guardSuperseded(record, records)) networkFail('codex-network-superseded');
}
