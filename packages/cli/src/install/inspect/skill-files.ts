// Which files of a tree are the file of a skill. A host on a disk that ignores letter case opens
// `skill.md` as `SKILL.md`, so the name is judged without regard to case; the tree refuses two names
// that are one name there, so a tree cannot hold both.
const NAME = 'skill.md';

/** A `SKILL.md` anywhere in the tree. */
export function isSkillFile(path: string): boolean {
  const slash = path.lastIndexOf('/');
  return path.slice(slash + 1).toLowerCase() === NAME;
}

/** The `SKILL.md` at the root of the tree, which is what makes the tree a skill. */
export const isRootSkillFile = (path: string): boolean => path.toLowerCase() === NAME;
