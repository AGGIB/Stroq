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
export function earlier(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (Number.isNaN(y)) return !Number.isNaN(x);
  return !Number.isNaN(x) && x < y;
}

/** What one session says of one key, reduced so that sessions can be merged without their sightings. */
export interface KeyInSession {
  /** The key's farthest place in this session, and of those the earliest. */
  readonly sighting: Sighting;
  /** Sightings in that place's rank. */
  readonly times: number;
  /** Sightings in any place. */
  readonly seen: number;
  /** The most later calls that could have sent the key, after any of its sightings here. */
  readonly later: number;
}

/** One session's keys, each reduced; what `collectFromSummaries` merges. */
export interface SessionKeySummary {
  readonly session: SessionInfo;
  readonly keys: ReadonlyMap<number, KeyInSession>;
}

/** The reduction of a key's sightings in one session, after one more. */
function reduceOne(current: KeyInSession | undefined, sighting: Sighting): KeyInSession {
  const later = sighting.laterNetwork ?? 0;
  if (current === undefined) return { sighting, times: 1, seen: 1, later };
  const seen = current.seen + 1;
  const most = Math.max(current.later, later);
  const rank = placeRank(sighting.place) - placeRank(current.sighting.place);
  if (rank < 0) return { sighting, times: 1, seen, later: most };
  if (rank > 0) return { ...current, seen, later: most };
  const times = current.times + 1;
  return earlier(sighting.at, current.sighting.at)
    ? { sighting, times, seen, later: most }
    : { ...current, times, seen, later: most };
}

/** One session's sightings, reduced to one entry per key, in the order the keys were first seen. */
export function summarizeSightings(sightings: readonly Sighting[]): Map<number, KeyInSession> {
  const out = new Map<number, KeyInSession>();
  for (const sighting of sightings)
    out.set(sighting.key, reduceOne(out.get(sighting.key), sighting));
  return out;
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

/** The later calls of a session, with one more session's most. */
function withLater(
  later: ReadonlyMap<string, number>,
  n: number,
  path: string,
): ReadonlyMap<string, number> {
  if (n <= (later.get(path) ?? 0)) return later;
  return new Map([...later, [path, n]]);
}

/** The best so far for a key, after one more session's reduction of it. */
function next(current: Best | undefined, one: KeyInSession, session: SessionInfo): Best {
  if (current === undefined)
    return {
      sighting: one.sighting,
      session,
      times: one.times,
      seen: one.seen,
      sessions: new Set([session.path]),
      later: withLater(new Map(), one.later, session.path),
    };
  const sessions = current.sessions.has(session.path)
    ? current.sessions
    : new Set([...current.sessions, session.path]);
  const seen = current.seen + one.seen;
  const later = withLater(current.later, one.later, session.path);
  const rank = placeRank(one.sighting.place) - placeRank(current.sighting.place);
  if (rank < 0) return { sighting: one.sighting, session, times: one.times, seen, sessions, later };
  if (rank > 0) return { ...current, seen, sessions, later };
  const times = current.times + one.times;
  return earlier(one.sighting.at, current.sighting.at)
    ? { sighting: one.sighting, session, times, seen, sessions, later }
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

/**
 * One finding per key, from sessions already reduced (`summarizeSightings`). The sessions are merged
 * in the order given, so the same sessions in the same order give the same findings, whether each was
 * read now or kept from an earlier run.
 */
export function collectFromSummaries(
  keys: readonly Key[],
  all: readonly SessionKeySummary[],
): Finding[] {
  const best = new Map<number, Best>();
  for (const { session, keys: seen } of all)
    for (const [index, one] of seen) best.set(index, next(best.get(index), one, session));
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

export function collectFindings(keys: readonly Key[], all: readonly SessionSightings[]): Finding[] {
  return collectFromSummaries(
    keys,
    all.map(({ session, sightings }) => ({ session, keys: summarizeSightings(sightings) })),
  );
}
