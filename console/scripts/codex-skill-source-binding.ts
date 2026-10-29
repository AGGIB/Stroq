import { isDeepStrictEqual } from 'node:util';
import { rootIdentity, type RootIdentity } from './inventory-observation-files.ts';

export interface CodexSkillRootBinding {
  project: RootIdentity;
  user: RootIdentity;
}
function valid(value: unknown): value is RootIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).sort().join(',') === 'dev,ino,mode,path,uid' &&
    typeof row.path === 'string' &&
    ['dev', 'ino', 'uid', 'mode'].every(
      (key) =>
        typeof row[key] === 'number' &&
        Number.isFinite(row[key]) &&
        Number.isInteger(row[key]) &&
        Number(row[key]) >= 0,
    )
  );
}
/** Private console-start identities; a preview may never rebind the selected directories. */
export async function assertCodexSkillRootBinding(
  project: string,
  userHome: string,
  expected: unknown,
): Promise<void> {
  if (
    expected === null ||
    typeof expected !== 'object' ||
    Array.isArray(expected) ||
    Object.keys(expected).sort().join(',') !== 'project,user'
  )
    throw Error('changed-context');
  const binding = expected as CodexSkillRootBinding;
  if (
    !valid(binding.project) ||
    !valid(binding.user) ||
    binding.project.path !== project ||
    binding.user.path !== userHome
  )
    throw Error('changed-context');
  try {
    const [currentProject, currentUser] = await Promise.all([
      rootIdentity(project),
      rootIdentity(userHome),
    ]);
    if (!isDeepStrictEqual(binding, { project: currentProject, user: currentUser })) throw Error();
  } catch {
    throw Error('changed-context');
  }
}
