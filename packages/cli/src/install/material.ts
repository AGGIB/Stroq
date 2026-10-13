import type { Passport } from './types.js';

const STRENGTH = { unknown: 0, declared: 1, observed: 2, limited: 3 } as const;

/** Capability locations and prose changing alone are not a new grant. Unknowns are conservative. */
export function materialChange(before: Passport, after: Passport): boolean {
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
