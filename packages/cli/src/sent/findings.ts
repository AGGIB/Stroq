// From sightings in many sessions to one finding per key.
//
// A key is reported once, under the most external tier any session put it in, with the call
// that put it there (the earliest such call), how many times it reached that tier, and in how
// many sessions it was seen at all. A finding holds the key's name and source, never its value.
import type { Sighting } from './analyze.js';
import type { Key } from './keys.js';
import { providerOf } from './own-service.js';
import { placeRank, tierRank, type Place, type Tier } from './place.js';

/** The session a finding's call was recorded in. */
export interface SessionInfo {
  readonly agent: string;
  readonly id: string;
  /** The transcript, rollout or `<store>#<session>` it was read from. */
  readonly path: string;
  readonly cwd: string | null;
}

export interface Finding {
  readonly tier: Tier;
  readonly name: string;
  readonly source: string;
  /** A canary planted with `stroq canary`. */
  readonly canary?: true;
  /** The service's label, from the table in `own-service.ts`. */
  readonly provider: string;
  readonly rotate: string | null;
  /** Where the call that put the key in this tier put it. */
  readonly place: Place;
  /** When, as ISO 8601; null when the record gave no time that reads as one. */
  readonly at: string | null;
  readonly session: SessionInfo;
  readonly subagent?: string;
  /** Sightings in this tier, over every session. */
  readonly times: number;
  /** Sessions the key was seen in, in any tier. */
  readonly sessions: number;
  /** Sightings in any tier. */
  readonly seen: number;
  /**
   * Calls after the key was seen, in the sessions it was seen in, that could have taken it out
   * without showing it: a command that can reach the network or that Stroq cannot read. Set when
   * there are any; it changes no tier.
   */
  readonly laterNetworkCommands?: number;
  /** How many sessions those calls are in, when more than one. */
  readonly laterNetworkSessions?: number;
}

export interface SessionSightings {
  readonly session: SessionInfo;
  readonly sightings: readonly Sighting[];
}

/**
 * A time a record gave, as ISO 8601, or null: a record can put any text where a time goes, and
 * only a time is printed.
 */
export function isoTime(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** A place with the time of what became of its file as ISO 8601, or null. */
const placeTimes = (place: Place): Place =>
  place.then === undefined
    ? place
    : { ...place, then: { ...place.then, at: isoTime(place.then.at) } };

/** Earlier first; a stamp that will not parse goes last. */
function earlier(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (Number.isNaN(y)) return !Number.isNaN(x);
  return !Number.isNaN(x) && x < y;
}

interface Best {
  readonly sighting: Sighting;
  readonly session: SessionInfo;
  readonly times: number;
  readonly seen: number;
  readonly sessions: ReadonlySet<string>;
  /** Per session, the most later calls that could have sent the key, after any of its sightings. */
  readonly later: ReadonlyMap<string, number>;
}

/** The later calls of a session, with one more sighting's. */
function withLater(
  later: ReadonlyMap<string, number>,
  sighting: Sighting,
  path: string,
): ReadonlyMap<string, number> {
  const n = sighting.laterNetwork ?? 0;
  if (n <= (later.get(path) ?? 0)) return later;
  return new Map([...later, [path, n]]);
}

/** The best so far for a key, after one more sighting of it. */
function next(current: Best | undefined, sighting: Sighting, session: SessionInfo): Best {
  if (current === undefined)
    return {
      sighting,
      session,
      times: 1,
      seen: 1,
      sessions: new Set([session.path]),
      later: withLater(new Map(), sighting, session.path),
    };
  const sessions = current.sessions.has(session.path)
    ? current.sessions
    : new Set([...current.sessions, session.path]);
  const seen = current.seen + 1;
  const later = withLater(current.later, sighting, session.path);
  const rank = placeRank(sighting.place) - placeRank(current.sighting.place);
  if (rank < 0) return { sighting, session, times: 1, seen, sessions, later };
  if (rank > 0) return { ...current, seen, sessions, later };
  const times = current.times + 1;
  return earlier(sighting.at, current.sighting.at)
    ? { sighting, session, times, seen, sessions, later }
    : { ...current, times, seen, sessions, later };
}

/** The later calls of every session the key was seen in, summed, and how many sessions hold any. */
function laterOf(b: Best): Pick<Finding, 'laterNetworkCommands' | 'laterNetworkSessions'> {
  const counts = [...b.later.values()].filter((n) => n > 0);
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (total === 0) return {};
  return {
    laterNetworkCommands: total,
    ...(counts.length > 1 ? { laterNetworkSessions: counts.length } : {}),
  };
}

export function collectFindings(keys: readonly Key[], all: readonly SessionSightings[]): Finding[] {
  const best = new Map<number, Best>();
  for (const { session, sightings } of all)
    for (const sighting of sightings)
      best.set(sighting.key, next(best.get(sighting.key), sighting, session));
  const findings = [...best.entries()].map(([index, b]): Finding => {
    const key = keys[index] as Key;
    const service = providerOf(key);
    return {
      tier: b.sighting.place.tier,
      name: key.name,
      source: key.source,
      ...(key.canary === true ? { canary: true as const } : {}),
      provider: service.label,
      rotate: service.rotate,
      place: placeTimes(b.sighting.place),
      at: isoTime(b.sighting.at),
      session: b.session,
      ...(b.sighting.subagent === undefined ? {} : { subagent: b.sighting.subagent }),
      times: b.times,
      sessions: b.sessions.size,
      seen: b.seen,
      ...(b.sighting.place.tier === 'seen' ? laterOf(b) : {}),
    };
  });
  // A canary leads its place: it is the clearest sign that something steered the agent.
  const decoyFirst = (f: Finding): number => (f.canary === true ? 0 : 1);
  return findings.sort(
    (a, b) =>
      tierRank(a.tier) - tierRank(b.tier) ||
      decoyFirst(a) - decoyFirst(b) ||
      (earlier(a.at ?? '', b.at ?? '') ? -1 : earlier(b.at ?? '', a.at ?? '') ? 1 : 0),
  );
}
