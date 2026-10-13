import type { Passport, Tree, TreeEntry } from './types.js';

const STRENGTH = { unknown: 0, declared: 1, observed: 2, limited: 3 } as const;

/** Capability locations and prose changing alone are not a new grant. Unknowns are conservative. */
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

export function materialChange(
  before: Passport,
  after: Passport,
  trees?: { before: Tree; after: Tree },
): boolean {
  if (trees !== undefined) {
    const prior = new Map(trees.before.entries.map((entry) => [entry.path, entry]));
    const next = new Map(trees.after.entries.map((entry) => [entry.path, entry]));
    if (
      changedFiles(trees.before, trees.after).some(
        ({ path }) =>
          !/\.(?:md|txt)$/i.test(path) ||
          (prior.get(path)?.exec !== next.get(path)?.exec &&
            (prior.get(path)?.exec === true || next.get(path)?.exec === true)),
      )
    )
      return true;
  }
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
      if (seen === undefined) return line.sensitive || line.basis === 'unknown';
      return (line.sensitive && !seen.sensitive) || STRENGTH[line.basis] < seen.strength;
    })
  )
    return true;
  const spots = new Set(before.blindSpots);
  return after.blindSpots.some((spot) => !spots.has(spot));
}
