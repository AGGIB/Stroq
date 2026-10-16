// How soon a person must see a line of a passport: the order of rows on a screen, and of what survives a cut.
//
// A passport is sorted by kind, alphabetically, so that the same artifact gives the same bytes. That order
// puts `allowed-tools` before `cred.file`, `exec` and `net`, and a screen that shows the first rows of it can
// be filled with one kind while the line that matters is below the fold. A screen therefore ranks the rows
// by what a person has to know first and keeps the passport's own order within a rank.
import type { CapKind } from '../types.js';

/** Lower is more severe. Every kind has a rank, so a new kind is a compile error until it is placed. */
const RANK: Readonly<Record<CapKind, number>> = {
  'cred.file': 0,
  'cred.env': 0,
  net: 1,
  exec: 2,
  hook: 3,
  'install-script': 4,
  'allowed-tools': 5,
  tool: 6,
  'fs.write': 7,
  'fs.read': 8,
  signal: 9,
};

export const severityRank = (kind: CapKind): number => RANK[kind];

/** The lines most severe kind first. The sort is stable, so lines of one kind keep the order they came in. */
export const bySeverity = <T extends { readonly kind: CapKind }>(lines: readonly T[]): T[] =>
  [...lines].sort((a, b) => severityRank(a.kind) - severityRank(b.kind));
