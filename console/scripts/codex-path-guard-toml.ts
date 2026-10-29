import { restorePathTomlOwnership } from './codex-path-guard-toml-restore.ts';
import {
  plain,
  same,
  validOperation,
  findCodexSkillTomlValue,
  replaceValue,
  insertNetworkTomlLeaf,
  eolFor,
  separatorFor,
  readPathToml,
  mutatePathToml,
  pathTomlErrors,
  pathTomlError,
  assertTargetPath,
  pathFilesystem,
  pathMarker,
  type PathTomlMutation,
} from './codex-path-guard-toml-shared.ts';
import { safeText } from './codex-skill-control-toml-shared.ts';
export interface CodexPathGuardInput {
  bytes: Uint8Array | null;
  operationId: string;
  targetPath: string;
}
export interface CodexPathGuardOwnership {
  schema: 'stroq-codex-path-guard-transform/1';
  kind: 'profile-path-deny';
  operationId: string;
  profileName: string;
  targetPath: string;
  before: Uint8Array;
  candidate: Uint8Array;
}
export interface CodexPathGuardPlan {
  kind: 'profile-path-deny';
  bytes: Uint8Array;
  owned: CodexPathGuardOwnership;
  profileName: string;
  ownedPath: string[];
  rulesBefore: number;
  effect: { filesystem: 'deny-exact-path'; targetReads: 'denied'; targetWrites: 'denied' };
}
/** Source/native parent resolution belongs to the caller; this pure transform owns one leaf. */
export function buildPathTomlGuard(input: CodexPathGuardInput) {
  if (
    !plain(input) ||
    Reflect.ownKeys(input).length !== 3 ||
    !['bytes', 'operationId', 'targetPath'].every((k) => Object.hasOwn(input, k)) ||
    !(input.bytes instanceof Uint8Array) ||
    !validOperation(input.operationId)
  )
    pathTomlError('invalid');
  assertTargetPath(input.targetPath);
  const before = readPathToml(input.bytes),
    document = before.document,
    name = document.default_permissions;
  if (
    !safeText(name, 2048) ||
    name === 'filesystem' ||
    name.startsWith(':') ||
    !plain(document.permissions) ||
    !Object.hasOwn(document.permissions, name) ||
    !plain(document.permissions[name])
  )
    pathTomlError('invalid');
  const profile = document.permissions[name],
    parent = profile.extends;
  if (
    parent !== undefined &&
    (!safeText(parent, 2048) ||
      parent === 'filesystem' ||
      (parent.startsWith(':') && ![':workspace', ':read-only'].includes(parent)))
  )
    pathTomlError('invalid');
  const { filesystem, rules, broaderDenied } = pathFilesystem(profile.filesystem, input.targetPath),
    previous = filesystem[input.targetPath];
  if (previous === 'deny' || (previous === undefined && broaderDenied))
    pathTomlError('already-denied');
  if (previous !== undefined && previous !== 'read' && previous !== 'write')
    pathTomlError('conflict');
  if (rules + (previous === undefined ? 1 : 0) > 512) pathTomlError('limit');
  const marker = pathMarker(input.operationId);
  if (before.index.comments.some((c) => before.text.slice(c.start, c.end) === marker))
    pathTomlError('conflict');
  const ownedPath = ['permissions', name, 'filesystem', input.targetPath],
    field = findCodexSkillTomlValue(before.index, ownedPath),
    eol = eolFor(before.text);
  const changes: PathTomlMutation[] = [
    field ? replaceValue(field, '"deny"') : insertNetworkTomlLeaf(before, ownedPath, '"deny"'),
    {
      start: before.text.length,
      end: before.text.length,
      text: separatorFor(before.text, eol) + marker + eol,
    },
  ];
  const bytes = Buffer.from(mutatePathToml(before.text, changes)),
    after = readPathToml(bytes);
  const expected = {
    ...document,
    permissions: {
      ...document.permissions,
      [name]: { ...profile, filesystem: { ...filesystem, [input.targetPath]: 'deny' } },
    },
  };
  if (!same(after.document, expected)) pathTomlError('invalid');
  return {
    before,
    after,
    bytes,
    changes,
    ownedPath,
    profileName: name,
    rulesBefore: rules,
    marker,
  };
}
export function planCodexPathGuard(input: CodexPathGuardInput): CodexPathGuardPlan {
  return pathTomlErrors(() => {
    const p = buildPathTomlGuard(input);
    return {
      kind: 'profile-path-deny',
      bytes: p.bytes,
      profileName: p.profileName,
      ownedPath: p.ownedPath,
      rulesBefore: p.rulesBefore,
      effect: { filesystem: 'deny-exact-path', targetReads: 'denied', targetWrites: 'denied' },
      owned: {
        schema: 'stroq-codex-path-guard-transform/1',
        kind: 'profile-path-deny',
        operationId: input.operationId,
        profileName: p.profileName,
        targetPath: input.targetPath,
        before: Buffer.from(input.bytes!),
        candidate: Buffer.from(p.bytes),
      },
    };
  });
}
export function restoreCodexPathGuard(input: {
  bytes: Uint8Array;
  owned: CodexPathGuardOwnership;
}): Uint8Array {
  return pathTomlErrors(() => restorePathTomlOwnership(input, buildPathTomlGuard), 'conflict');
}
