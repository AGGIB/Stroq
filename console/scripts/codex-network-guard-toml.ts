import { restoreNetworkTomlOwnership } from './codex-network-guard-toml-restore.ts';
import {
  findCodexSkillTomlValue,
  plain,
  same,
  validOperation,
  readNetworkToml,
  networkTomlError,
  markerFor,
  eolFor,
  separatorFor,
  inlineInsertion,
  insertNetworkTomlLeaf,
  replaceValue,
  mutateNetworkToml,
  type NetworkTomlMutation,
} from './codex-network-guard-toml-shared.ts';
export type CodexNetworkGuardKind =
  'profile-child' | 'profile-network-off' | 'legacy-network-off' | 'legacy-enable-workspace';
export interface CodexNetworkGuardOwnership {
  schema: 'stroq-codex-network-guard-transform/1';
  operationId: string;
  kind: CodexNetworkGuardKind;
  before: Uint8Array | null;
  candidate: Uint8Array;
  parentProfile: string | null;
  childProfile: string | null;
}
export interface CodexNetworkGuardPlan {
  bytes: Uint8Array;
  owned: CodexNetworkGuardOwnership;
  profileName?: string;
  changesFilesystem: boolean;
  retainsProfileOnRestore: boolean;
  effect: { filesystem: 'unchanged' | 'workspace-restricted'; network: 'off' };
}
export type CodexNetworkGuardInput = {
  bytes: Uint8Array | null;
  operationId: string;
  kind: CodexNetworkGuardKind;
};
/** Pure raw-span transform. Parent graph eligibility and native compatibility remain caller-owned. */
export function buildNetworkTomlGuard(input: CodexNetworkGuardInput) {
  if (
    input.bytes === null ||
    !validOperation(input.operationId) ||
    ![
      'profile-child',
      'profile-network-off',
      'legacy-network-off',
      'legacy-enable-workspace',
    ].includes(input.kind)
  )
    return networkTomlError('invalid');
  const before = readNetworkToml(input.bytes),
    doc = before.document,
    marker = markerFor(input.operationId),
    eol = eolFor(before.text);
  if (before.text.includes(marker)) return networkTomlError('conflict');
  const changes: NetworkTomlMutation[] = [],
    ownedPaths: string[][] = [];
  let parentProfile: string | null = null,
    childProfile: string | null = null,
    changesFilesystem = false,
    expected: Record<string, unknown>;
  const append = (text: string) =>
    changes.push({
      start: before.text.length,
      end: before.text.length,
      text: separatorFor(before.text, eol) + text,
    });
  if (input.kind === 'profile-child') {
    if (doc.default_permissions !== ':danger-full-access') return networkTomlError('invalid');
    childProfile = 'stroq-network-' + input.operationId;
    if (
      doc.default_permissions === childProfile ||
      (plain(doc.permissions) && Object.hasOwn(doc.permissions, childProfile))
    )
      return networkTomlError('conflict');
    changesFilesystem = doc.default_permissions === ':danger-full-access';
    parentProfile = changesFilesystem ? ':workspace' : doc.default_permissions;
    const child = { extends: parentProfile, network: { enabled: false } },
      permissions = plain(doc.permissions) ? doc.permissions : {};
    expected = {
      ...doc,
      default_permissions: childProfile,
      permissions: { ...permissions, [childProfile]: child },
    };
    changes.push(
      replaceValue(
        findCodexSkillTomlValue(before.index, ['default_permissions']),
        JSON.stringify(childProfile),
      ),
    );
    ownedPaths.push(['default_permissions']);
    const parent = findCodexSkillTomlValue(before.index, ['permissions']);
    if (parent?.value.kind === 'inline') {
      changes.push(
        inlineInsertion(
          parent.value,
          JSON.stringify(childProfile) +
            ' = { extends = ' +
            JSON.stringify(parentProfile) +
            ', network = { enabled = false } }',
        ),
      );
      append(marker + eol);
    } else
      append(
        marker +
          eol +
          '[permissions.' +
          JSON.stringify(childProfile) +
          ']' +
          eol +
          'extends = ' +
          JSON.stringify(parentProfile) +
          eol +
          '[permissions.' +
          JSON.stringify(childProfile) +
          '.network]' +
          eol +
          'enabled = false' +
          eol,
      );
  } else if (input.kind === 'profile-network-off') {
    const name = doc.default_permissions;
    if (
      typeof name !== 'string' ||
      name.startsWith(':') ||
      !plain(doc.permissions) ||
      !Object.hasOwn(doc.permissions, name) ||
      !plain(doc.permissions[name])
    )
      return networkTomlError('invalid');
    const profile = doc.permissions[name],
      network = profile.network;
    if (
      (network !== undefined && !plain(network)) ||
      (plain(network) && network.enabled !== undefined && network.enabled !== true)
    )
      return networkTomlError('invalid');
    const path = ['permissions', name, 'network', 'enabled'];
    expected = {
      ...doc,
      permissions: {
        ...doc.permissions,
        [name]: { ...profile, network: { ...(plain(network) ? network : {}), enabled: false } },
      },
    };
    ownedPaths.push(path);
    const field = findCodexSkillTomlValue(before.index, path);
    changes.push(
      field ? replaceValue(field, 'false') : insertNetworkTomlLeaf(before, path, 'false'),
    );
    append(marker + eol);
  } else {
    if (doc.default_permissions !== undefined) return networkTomlError('invalid');
    const workspace = plain(doc.sandbox_workspace_write) ? doc.sandbox_workspace_write : {};
    if (input.kind === 'legacy-network-off' && workspace.network_access !== true)
      return networkTomlError('invalid');
    if (input.kind === 'legacy-enable-workspace') {
      if (doc.sandbox_mode !== 'danger-full-access') return networkTomlError('invalid');
      changesFilesystem = true;
      changes.push(
        replaceValue(findCodexSkillTomlValue(before.index, ['sandbox_mode']), '"workspace-write"'),
      );
      ownedPaths.push(['sandbox_mode']);
    }
    expected = {
      ...doc,
      ...(changesFilesystem ? { sandbox_mode: 'workspace-write' } : {}),
      sandbox_workspace_write: { ...workspace, network_access: false },
    };
    ownedPaths.push(['sandbox_workspace_write', 'network_access']);
    const field = findCodexSkillTomlValue(before.index, [
      'sandbox_workspace_write',
      'network_access',
    ]);
    if (field) changes.push(replaceValue(field, 'false'));
    else {
      const parent = findCodexSkillTomlValue(before.index, ['sandbox_workspace_write']);
      if (parent?.value.kind === 'inline')
        changes.push(inlineInsertion(parent.value, 'network_access = false'));
      else {
        const header = before.index.headers.find(
          (h) => !h.array && same(h.path, ['sandbox_workspace_write']),
        );
        let at: number, text: string;
        if (header) {
          const newline = before.text.indexOf('\n', header.end);
          at = newline < 0 ? before.text.length : newline + 1;
          text = (newline < 0 ? eol : '') + 'network_access = false' + eol;
        } else {
          at = before.index.headers[0]?.start ?? before.text.length;
          text =
            (at === before.text.length ? separatorFor(before.text, eol) : '') +
            (doc.sandbox_workspace_write === undefined
              ? 'sandbox_workspace_write = { network_access = false }'
              : 'sandbox_workspace_write.network_access = false') +
            eol;
        }
        changes.push({ start: at, end: at, text });
      }
    }
    append(marker + eol);
  }
  const text = mutateNetworkToml(before.text, changes),
    bytes = Buffer.from(text),
    after = readNetworkToml(bytes);
  if (!same(after.document, expected)) return networkTomlError('invalid');
  return {
    before,
    after,
    bytes,
    changes,
    ownedPaths,
    parentProfile,
    childProfile,
    changesFilesystem,
    marker,
  };
}
export function planCodexNetworkGuard(input: CodexNetworkGuardInput): CodexNetworkGuardPlan {
  const result = buildNetworkTomlGuard(input);
  const profileName =
    result.childProfile ??
    (input.kind === 'profile-network-off'
      ? (result.before.document.default_permissions as string)
      : undefined);
  return {
    bytes: result.bytes,
    owned: {
      schema: 'stroq-codex-network-guard-transform/1',
      operationId: input.operationId,
      kind: input.kind,
      before: input.bytes === null ? null : Buffer.from(input.bytes),
      candidate: Buffer.from(result.bytes),
      parentProfile: result.parentProfile,
      childProfile: result.childProfile,
    },
    ...(profileName ? { profileName } : {}),
    changesFilesystem: result.changesFilesystem,
    retainsProfileOnRestore: input.kind === 'profile-child',
    effect: {
      filesystem: result.changesFilesystem ? 'workspace-restricted' : 'unchanged',
      network: 'off',
    },
  };
}
export function restoreCodexNetworkGuard(input: {
  bytes: Uint8Array;
  owned: CodexNetworkGuardOwnership;
}): Uint8Array | null {
  return restoreNetworkTomlOwnership(input, buildNetworkTomlGuard);
}
