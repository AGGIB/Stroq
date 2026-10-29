import type { buildPathTomlGuard, CodexPathGuardOwnership } from './codex-path-guard-toml.ts';
import { codexSkillTomlFieldRemoval } from './codex-skill-control-toml-lex.ts';
import {
  plain,
  same,
  readPathToml,
  pathTomlError,
  pathTomlErrors,
  pathFilesystem,
  valueAt,
  findCodexSkillTomlValue,
  replaceValue,
  mutatePathToml,
  inlineNetworkFieldOwner,
  ownerMarkerSpan,
  uniqueInsertionRemoval,
  type PathTomlMutation,
} from './codex-path-guard-toml-shared.ts';
function restoreExpected(
  current: Record<string, unknown>,
  original: Record<string, unknown>,
  after: Record<string, unknown>,
  path: string[],
): Record<string, unknown> {
  const key = path[0]!,
    result = { ...current };
  if (path.length === 1) {
    if (original[key] === undefined) delete result[key];
    else result[key] = original[key];
    return result;
  }
  const child = restoreExpected(
    plain(current[key]) ? current[key] : {},
    plain(original[key]) ? original[key] : {},
    plain(after[key]) ? after[key] : {},
    path.slice(1),
  );
  if (original[key] === undefined && after[key] === undefined && Object.keys(child).length === 0)
    delete result[key];
  else result[key] = child;
  return result;
}
function ownership(owned: CodexPathGuardOwnership, build: typeof buildPathTomlGuard) {
  if (
    !plain(owned) ||
    Reflect.ownKeys(owned).length !== 7 ||
    !['schema', 'kind', 'operationId', 'profileName', 'targetPath', 'before', 'candidate'].every(
      (k) => Object.hasOwn(owned, k),
    ) ||
    owned.schema !== 'stroq-codex-path-guard-transform/1' ||
    owned.kind !== 'profile-path-deny' ||
    !(owned.before instanceof Uint8Array) ||
    !(owned.candidate instanceof Uint8Array) ||
    owned.before.byteLength > 256 * 1024 ||
    owned.candidate.byteLength > 256 * 1024
  )
    pathTomlError('conflict');
  try {
    const p = build({
      bytes: owned.before,
      operationId: owned.operationId,
      targetPath: owned.targetPath,
    });
    if (
      p.profileName !== owned.profileName ||
      !Buffer.from(p.bytes).equals(Buffer.from(owned.candidate))
    )
      pathTomlError('conflict');
    return p;
  } catch {
    return pathTomlError('conflict');
  }
}
export function restorePathTomlOwnership(
  input: { bytes: Uint8Array; owned: CodexPathGuardOwnership },
  build: typeof buildPathTomlGuard,
): Uint8Array {
  if (
    !plain(input) ||
    Reflect.ownKeys(input).length !== 2 ||
    !['bytes', 'owned'].every((k) => Object.hasOwn(input, k)) ||
    !(input.bytes instanceof Uint8Array)
  )
    pathTomlError('conflict');
  const p = ownership(input.owned, build),
    current = readPathToml(input.bytes),
    path = p.ownedPath,
    original = p.before.document,
    marker = ownerMarkerSpan(current, p.marker);
  if (valueAt(current.document, path) !== 'deny') pathTomlError('conflict');
  const profile = valueAt(current.document, ['permissions', p.profileName]),
    prior = valueAt(original, ['permissions', p.profileName, 'filesystem']);
  if (!plain(profile)) pathTomlError('conflict');
  if (valueAt(original, path) !== undefined)
    pathFilesystem(profile.filesystem, input.owned.targetPath, plain(prior) ? prior : {});
  const now = findCodexSkillTomlValue(current.index, path),
    candidate = findCodexSkillTomlValue(p.after.index, path),
    before = findCodexSkillTomlValue(p.before.index, path);
  if (
    !now ||
    !candidate ||
    current.text.slice(now.value.start, now.value.end) !==
      p.after.text.slice(candidate.value.start, candidate.value.end)
  )
    pathTomlError('conflict');
  if (Buffer.from(input.bytes).equals(Buffer.from(p.bytes))) return Buffer.from(input.owned.before);
  const replacements: PathTomlMutation[] = [],
    removed: PathTomlMutation[] = [];
  if (before)
    replacements.push(replaceValue(now, p.before.text.slice(before.value.start, before.value.end)));
  else {
    const parent = inlineNetworkFieldOwner(current, path, now);
    if (parent)
      removed.push(
        ...codexSkillTomlFieldRemoval(parent, now).map((span) => ({ ...span, text: '' })),
      );
    else removed.push({ start: now.start, end: now.value.end, text: '' });
  }
  const accept = (changes: PathTomlMutation[]) => {
    const bytes = Buffer.from(mutatePathToml(current.text, changes)),
      after = readPathToml(bytes).document,
      expected = restoreExpected(current.document, original, after, path);
    if (!same(after, expected)) pathTomlError('conflict');
    return bytes;
  };
  const exact = uniqueInsertionRemoval(current.text, p.changes);
  if (exact?.some((span) => span.start <= marker.start && span.end >= marker.end))
    try {
      return accept([...replacements, ...exact]);
    } catch {}
  return pathTomlErrors(() => accept([...replacements, ...removed, marker]), 'conflict');
}
