import type { Atom, AtomKind } from '../types.js';
import type { Ecosystem } from './package-name.js';

/**
 * The kinds of atom that can raise the floor of a session whose records are incomplete: a
 * package, a pipe-to-shell and an encoded blob. A URL or a host never does, however
 * network-shaped the action (see `floorAtoms` in `action-atoms.ts`), so losing one is not a loss
 * a session has to be marked for, and keeping one must not use up room the others need.
 */
export const FLOOR_KINDS: readonly AtomKind[] = ['pkg', 'pipe_shell', 'encoded'];

export const isFloorKind = (kind: AtomKind): boolean => FLOOR_KINDS.includes(kind);

/** An atom paired with the text index its source match started at, for cross-kind ordering. */
export interface Positioned {
  readonly index: number;
  readonly atom: Atom;
  /** For a package: the name as it was written and the registry the tool that named it uses. */
  readonly named?: { readonly name: string; readonly ecosystem: Ecosystem };
}
