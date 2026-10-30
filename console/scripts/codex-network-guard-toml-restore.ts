import type {
  buildNetworkTomlGuard,
  CodexNetworkGuardOwnership,
} from './codex-network-guard-toml.ts';
import { codexSkillTomlFieldRemoval } from './codex-skill-control-toml-lex.ts';
import {
  findCodexSkillTomlValue,
  inlineNetworkFieldOwner,
  plain,
  same,
  readNetworkToml,
  networkTomlError,
  ownerMarkerSpan,
  uniqueInsertionRemoval,
  replaceValue,
  mutateNetworkToml,
  type NetworkTomlMutation,
} from './codex-network-guard-toml-shared.ts';
const equalBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const valueAt = (doc: Record<string, unknown>, path: string[]): unknown =>
  path.reduce<unknown>((v, k) => (plain(v) ? v[k] : undefined), doc);
function restoreExpectedPath(
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
  const child = restoreExpectedPath(
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
function ownership(owned: CodexNetworkGuardOwnership, build: typeof buildNetworkTomlGuard) {
  if (
    !plain(owned) ||
    Object.keys(owned).sort().join() !==
      ['schema', 'operationId', 'kind', 'before', 'candidate', 'parentProfile', 'childProfile']
        .sort()
        .join() ||
    owned.schema !== 'stroq-codex-network-guard-transform/1' ||
    !(owned.candidate instanceof Uint8Array)
  )
    return networkTomlError('conflict');
  try {
    const p = build({ bytes: owned.before, operationId: owned.operationId, kind: owned.kind });
    if (
      !equalBytes(p.bytes, owned.candidate) ||
      p.parentProfile !== owned.parentProfile ||
      p.childProfile !== owned.childProfile
    )
      return networkTomlError('conflict');
    return p;
  } catch {
    return networkTomlError('conflict');
  }
}
/** Keep a profile child on restore: unobserved external references may now depend on it. */
export function restoreNetworkTomlOwnership(
  input: { bytes: Uint8Array; owned: CodexNetworkGuardOwnership },
  build: typeof buildNetworkTomlGuard,
): Uint8Array | null {
  const p = ownership(input.owned, build),
    current = readNetworkToml(input.bytes),
    marker = ownerMarkerSpan(current, p.marker),
    original = p.before.document;
  for (const path of p.ownedPaths)
    if (!same(valueAt(current.document, path), valueAt(p.after.document, path)))
      return networkTomlError('conflict');
  if (input.owned.kind === 'profile-child') {
    if (
      !plain(current.document.permissions) ||
      !same(
        current.document.permissions[p.childProfile!],
        p.after.document.permissions && plain(p.after.document.permissions)
          ? p.after.document.permissions[p.childProfile!]
          : undefined,
      )
    )
      return networkTomlError('conflict');
    const field = findCodexSkillTomlValue(current.index, ['default_permissions']),
      before = findCodexSkillTomlValue(p.before.index, ['default_permissions']);
    if (!before) return networkTomlError('conflict');
    const candidate = Buffer.from(
      mutateNetworkToml(current.text, [
        replaceValue(field, p.before.text.slice(before.value.start, before.value.end)),
      ]),
    );
    if (
      !same(readNetworkToml(candidate).document, {
        ...current.document,
        default_permissions: original.default_permissions,
      })
    )
      return networkTomlError('conflict');
    return candidate;
  }
  if (equalBytes(input.bytes, p.bytes))
    return input.owned.before === null ? null : Buffer.from(input.owned.before);
  const replacements: NetworkTomlMutation[] = [],
    removed: NetworkTomlMutation[] = [];
  for (const path of p.ownedPaths) {
    const now = findCodexSkillTomlValue(current.index, path),
      before = findCodexSkillTomlValue(p.before.index, path);
    if (!now) return networkTomlError('conflict');
    if (before)
      replacements.push(
        replaceValue(now, p.before.text.slice(before.value.start, before.value.end)),
      );
    else {
      const parent = inlineNetworkFieldOwner(current, path, now);
      if (parent)
        removed.push(...codexSkillTomlFieldRemoval(parent, now).map((s) => ({ ...s, text: '' })));
      else removed.push({ start: now.start, end: now.value.end, text: '' });
    }
  }
  const accept = (changes: NetworkTomlMutation[]) => {
    const bytes = Buffer.from(mutateNetworkToml(current.text, changes)),
      after = readNetworkToml(bytes).document;
    let expected = current.document;
    for (const path of p.ownedPaths)
      expected = restoreExpectedPath(expected, original, after, path);
    if (!same(after, expected)) return networkTomlError('conflict');
    return bytes;
  };
  const exact = uniqueInsertionRemoval(current.text, p.changes);
  if (exact) {
    try {
      return accept([...replacements, ...exact]);
    } catch {}
  }
  try {
    return accept([...replacements, ...removed, marker]);
  } catch {
    return networkTomlError('conflict');
  }
}
