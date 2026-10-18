import type { Atom, PreToolEvent, ProvenanceHit, ProvenanceRecord } from '../types.js';
import { readActionAtoms } from './action-atoms.js';
import { atomHash } from './atoms.js';
import type { ProvenanceStore } from './store.js';

/** What the provenance store knew about the atoms of one proposed action. */
export interface ProvenanceLookup {
  readonly hits: readonly ProvenanceHit[];
  /** Atoms with no record, while the session's records are incomplete; empty otherwise. */
  readonly unrecorded: readonly Atom[];
  /**
   * The command could not be read to its end, and the session has something the part that was
   * not read could be matched against: it is flagged, its records are incomplete, or it has
   * recorded something. False for a session with none of those, which no unread text can be
   * checked against and which an ordinary long command must not trouble.
   */
  readonly unread: boolean;
}

export const NO_LOOKUP: ProvenanceLookup = { hits: [], unrecorded: [], unread: false };

/**
 * One hit per distinct atom of the action. The most recent record of an atom is its hit, unless
 * an older one flagged it: a record that was flagged wins over every later record of the same atom
 * until the session is cleared (`stroq untaint`). A page that repeats the name of a package that
 * a flagged page named does not make it any less what the flagged page said it was. `records` are
 * the most recent first, as `ProvenanceStore.lookup` returns them.
 */
function hitsOf(
  byHash: ReadonlyMap<string, Atom>,
  records: readonly ProvenanceRecord[],
): ProvenanceHit[] {
  const chosen = new Map<string, ProvenanceHit>();
  for (const record of records) {
    const atom = byHash.get(record.hash);
    if (atom === undefined) continue;
    const key = atomKey(atom);
    const current = chosen.get(key);
    if (current === undefined || (!current.record.suspect && record.suspect))
      chosen.set(key, { atom, record });
  }
  return [...chosen.values()];
}

const atomKey = (atom: Atom): string => `${atom.kind}\n${atom.value}`;

/**
 * The hashes under which the records of an atom may be kept. A blob in a command is looked up as
 * the cheap hash of the same value too: a page that labelled a token as a hash recorded it as one
 * (see `encodedAtoms`), and the command that carries the bare token is a copy of it.
 */
function hashesOf(atom: Atom): string[] {
  const own = atomHash(atom);
  return atom.kind === 'encoded' ? [own, atomHash({ kind: 'digest', value: atom.value })] : [own];
}

/**
 * What the store knew about the atoms of the proposed action: one hit per distinct atom (see
 * `hitsOf` for which record) and, when the session's records are known to be incomplete, the atoms
 * that no record holds: those are not "never read", they are "cannot say". And whether the unread
 * part of a command counts.
 */
export async function findActionProvenance(
  store: ProvenanceStore | undefined,
  event: PreToolEvent,
  tainted: boolean,
): Promise<ProvenanceLookup> {
  if (!store) return NO_LOOKUP;
  const { atoms, unread } = readActionAtoms(event.toolName, event.toolInput, event.cwd);
  if (atoms.length === 0 && !unread) return NO_LOOKUP;
  const byHash = new Map(
    atoms.flatMap((atom) => hashesOf(atom).map((hash) => [hash, atom] as const)),
  );
  const records = byHash.size === 0 ? [] : await store.lookup(event.sessionId, [...byHash.keys()]);
  const hits = hitsOf(byHash, records);
  const seen = new Set(hits.map((hit) => atomKey(hit.atom)));
  // After the lookup, not before: see `ProvenanceStore.isIncomplete`.
  const incomplete = await store.isIncomplete(event.sessionId);
  const unrecorded = incomplete ? atoms.filter((atom) => !seen.has(atomKey(atom))) : [];
  const unreadCounts =
    unread && (tainted || incomplete || (await store.hasEvidence(event.sessionId)));
  return { hits, unrecorded, unread: unreadCounts };
}
