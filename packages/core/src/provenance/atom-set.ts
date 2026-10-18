import type { Atom } from '../types.js';
import { isFloorKind } from './atom-kinds.js';

/**
 * The atoms kept from one reading, deduped, with the budgets that bound them: one for the atoms
 * that can raise the floor (a package, a pipe-to-shell, an encoded blob), one for the URLs and
 * hosts, and one for the hashes (a labelled token that is not text), none of which can. A floor
 * atom that did not fit is a loss and is remembered as one; any other that did not fit is left
 * out and nothing else is said.
 */
export interface AtomSet {
  readonly atoms: Atom[];
  /** Adds the atom, unless it is a repeat or its budget is spent. */
  add(atom: Atom): void;
  /** The floor budget is spent: nothing more of that kind is read, and the loss is already certain. */
  readonly floorFull: boolean;
  /** A distinct floor atom was left out because the budget was spent. */
  readonly floorLeftOut: boolean;
}

export function createAtomSet(maxFloor: number, maxNetwork: number, maxDigest: number): AtomSet {
  const seen = new Set<string>();
  const atoms: Atom[] = [];
  let floor = 0;
  let network = 0;
  let digest = 0;
  let floorLeftOut = false;
  return {
    atoms,
    add(atom: Atom): void {
      const key = `${atom.kind}\n${atom.value}`;
      if (seen.has(key)) return;
      if (isFloorKind(atom.kind)) {
        if (floor >= maxFloor) {
          floorLeftOut = true;
          return;
        }
        floor += 1;
      } else if (atom.kind === 'digest') {
        if (digest >= maxDigest) return;
        digest += 1;
      } else {
        if (network >= maxNetwork) return;
        network += 1;
      }
      seen.add(key);
      atoms.push(atom);
    },
    get floorFull(): boolean {
      return floor >= maxFloor;
    },
    get floorLeftOut(): boolean {
      return floorLeftOut;
    },
  };
}
