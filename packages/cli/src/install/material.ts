import type { Passport, Tree, TreeEntry } from './types.js';

const STRENGTH = { unknown: 0, declared: 1, observed: 2, limited: 3 } as const;

/**
 * The files whose change alone does not need another typed digest: `README`, `CHANGELOG`, `LICENSE` and
 * `CONTRIBUTING`, with `.md` or `.txt`, at the top of the tree, spelled in any case of the ASCII letters. Nothing
 * else: a skill points its agent at `docs/`, at references and at examples, and the agent follows what it
 * finds there, as it follows `SKILL.md`, the commands and the agents. The name is compared as the tree
 * spells it, whole: a folder, a backslash, another extension, a trailing dot or blank, a name with
 * `README.md` inside it, and every letter that only looks like one of these (the Kelvin sign, the long s, a
 * full-width letter) are not it. The pattern has no `u` flag, so the case folding is the ASCII one.
 */
const DOCUMENT = /^(?:README|CHANGELOG|LICENSE|CONTRIBUTING)\.(?:md|txt)$/i;

export const isDocumentation = (path: string): boolean => DOCUMENT.test(path);

/** Text a person can read: valid UTF-8 with no NUL. A document that turns into anything else is not a document. */
function isPlainText(bytes: Uint8Array | undefined): boolean {
  if (bytes === undefined) return false;
  try {
    return !new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\u0000');
  } catch {
    return false;
  }
}

/** The files that differ between two trees, and how. */
export function changedFiles(before: Tree, after: Tree): { path: string; change: string }[] {
  const old = new Map(before.entries.map((entry) => [entry.path, entry]));
  const next = new Map(after.entries.map((entry) => [entry.path, entry]));
  const same = (a: TreeEntry, b: TreeEntry): boolean =>
    a.kind === b.kind && a.sha256 === b.sha256 && a.exec === b.exec && a.size === b.size;
  return [...new Set([...old.keys(), ...next.keys()])].sort().flatMap((path) => {
    const a = old.get(path);
    const b = next.get(path);
    if (a !== undefined && b !== undefined && same(a, b)) return [];
    return [{ path, change: a === undefined ? 'added' : b === undefined ? 'removed' : 'changed' }];
  });
}

/**
 * Whether the files that differ need the typed digest. Only an added or changed document that stays plain
 * text, a file and not executable, does not. Everything else does: any other file, a file that is removed
 * (a rename is a removal and an addition), an executable bit on either side, a link or a nested repository,
 * and a document that is, or was, not text. It can only ask for more than it did when it only knew `.md`
 * and `.txt`.
 */
function filesNeedConfirmation(before: Tree, after: Tree): boolean {
  const prior = new Map(before.entries.map((entry) => [entry.path, entry]));
  const next = new Map(after.entries.map((entry) => [entry.path, entry]));
  return changedFiles(before, after).some(({ path, change }) => {
    if (change === 'removed' || !isDocumentation(path)) return true;
    const was = prior.get(path);
    const is = next.get(path);
    if (is?.kind !== 'file' || is.exec || !isPlainText(is.bytes)) return true;
    return was !== undefined && (was.kind !== 'file' || was.exec || !isPlainText(was.bytes));
  });
}

export function materialChange(
  before: Passport,
  after: Passport,
  trees?: { before: Tree; after: Tree },
): boolean {
  if (trees !== undefined && filesNeedConfirmation(trees.before, trees.after)) return true;
  if (JSON.stringify(before.artifact.source) !== JSON.stringify(after.artifact.source)) return true;
  const prior = new Map<string, { strength: number; sensitive: boolean }>();
  for (const line of before.lines) {
    const key = JSON.stringify([line.kind, line.subject]);
    const seen = prior.get(key);
    prior.set(key, {
      strength: Math.max(seen?.strength ?? 0, STRENGTH[line.basis]),
      sensitive: line.sensitive || seen?.sensitive === true,
    });
  }
  if (
    after.lines.some((line) => {
      const seen = prior.get(JSON.stringify([line.kind, line.subject]));
      // A line that is new is a capability that was not confirmed, whatever it looks like: `Bash(cat:*)` is
      // an allowed tool that reads any file, and a document that gains a code block gains the command in it.
      // Only a rule that matched (a signal) is a reading and not a capability.
      if (seen === undefined)
        return line.sensitive || line.basis === 'unknown' || line.kind !== 'signal';
      return (line.sensitive && !seen.sensitive) || STRENGTH[line.basis] < seen.strength;
    })
  )
    return true;
  const spots = new Set(before.blindSpots);
  return after.blindSpots.some((spot) => !spots.has(spot));
}
