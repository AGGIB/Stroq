// A transcript's key check as the card keeps it, and back into the findings of a run.
//
// The check (`sent/scan-sessions.ts`) answers with sightings that name keys by their place in the
// finder. What is kept names them by their number in the index (`key-index.ts`), carries no value, and
// has the times as ISO 8601 or empty (a record can put any text where a time goes, and only a time is
// kept). A run builds its findings from kept results and fresh ones the same way, in the order of the
// sessions, so a run that read a transcript and a run that kept it give the same card.
import type { Sighting } from '../sent/analyze.js';
import {
  collectFromSummaries,
  compareFindings,
  earlier,
  isoTime,
  type Finding,
  type KeyInSession,
  type SessionInfo,
  type SessionKeySummary,
} from '../sent/findings.js';
import type { Key, KeyFinder } from '../sent/keys.js';
import { placeRank, type Evidence, type Place } from '../sent/place.js';
import { printableFinding, printableId } from '../sent/run.js';
import { mayHaveSent, type PlacedFinding } from './key-moments.js';
import type { Scrub } from './scrub.js';
import { MAX_HITS, type SessionKeys, type StoredHit } from './key-schema.js';
import { isInside } from './within.js';

/** A place with the time of what became of its file as ISO 8601, or null. */
const timed = (place: Place): Place =>
  place.then === undefined
    ? place
    : { ...place, then: { ...place.then, at: isoTime(place.then.at) } };

/** The latest of two stamps; empty if either is (a sighting with no time is always inside a window). */
function latest(a: string, b: string): string {
  if (a === '' || b === '') return '';
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return '';
  return x >= y ? a : b;
}

/** A key's sightings in one distance (`placeRank`) in one transcript. */
interface Reach {
  readonly sighting: Sighting;
  readonly times: number;
  readonly last: string;
}

/** The time a stamp reads as, or Infinity for one that will not read: it can be cut by no window. */
const lastMs = (stamp: string): number => {
  const ms = stamp === '' ? Number.NaN : Date.parse(stamp);
  return Number.isNaN(ms) ? Infinity : ms;
};

/**
 * What one key did in one transcript, as what is kept: for each distance it reached, where it first
 * went, how often, and when it last did. A distance is left out when a farther one was reached at
 * least as late: any window that holds the nearer sighting holds the farther. So the card can apply a
 * window by event time to a result kept without one.
 */
function reaches(sightings: readonly Sighting[]): {
  reached: Reach[];
  seen: number;
  later: number;
} {
  const byRank = new Map<number, Reach>();
  let later = 0;
  for (const sighting of sightings) {
    later = Math.max(later, sighting.laterNetwork ?? 0);
    const rank = placeRank(sighting.place);
    const held = byRank.get(rank);
    const at = isoTime(sighting.at) ?? '';
    if (held === undefined) {
      byRank.set(rank, { sighting, times: 1, last: at });
      continue;
    }
    byRank.set(rank, {
      sighting: earlier(sighting.at, held.sighting.at) ? sighting : held.sighting,
      times: held.times + 1,
      last: latest(held.last, at),
    });
  }
  const farthestFirst = [...byRank.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  const reached: Reach[] = [];
  for (const r of farthestFirst)
    if (!reached.some((kept) => lastMs(kept.last) >= lastMs(r.last))) reached.push(r);
  return { reached, seen: sightings.length, later };
}

/** One transcript's sightings as what is kept: the hits of each key, in the order the keys were first seen. */
export function hitsOf(sightings: readonly Sighting[], idOf: readonly number[]): StoredHit[] {
  const perKey = new Map<number, Sighting[]>();
  for (const sighting of sightings) {
    const list = perKey.get(sighting.key);
    if (list === undefined) perKey.set(sighting.key, [sighting]);
    else list.push(sighting);
  }
  const hits: StoredHit[] = [];
  for (const [key, list] of perKey) {
    const k = idOf[key];
    if (k === undefined) continue;
    const { reached, seen, later } = reaches(list);
    for (const r of reached)
      hits.push({
        k,
        place: timed(r.sighting.place) as StoredHit['place'],
        at: isoTime(r.sighting.at) ?? '',
        last: r.last,
        ...(r.sighting.subagent === undefined ? {} : { subagent: r.sighting.subagent }),
        times: r.times,
        seen,
        later,
      });
  }
  return hits;
}

/** Whether a result is small enough to be kept. */
export const fitsKept = (result: SessionKeys): boolean => result.hits.length <= MAX_HITS;

/**
 * The evidence of a place with a key taken out of it once more, here in the main thread, where the keys are
 * known: a text that still holds a value after that is dropped, and the place keeps what linked the call.
 */
function sanitizeEvidence(evidence: Evidence, finder: KeyFinder, scrub: Scrub): Evidence {
  const text = scrub(evidence.text);
  const word = evidence.word === undefined ? undefined : scrub(evidence.word);
  return {
    text: finder.holds(text) ? '' : text,
    matched: evidence.matched,
    ...(word === undefined || finder.holds(word) ? {} : { word }),
  };
}

/** Takes a key out of every string a result holds, and keeps an id only if it is safe to print. */
export function sanitizeKeys(result: SessionKeys, finder: KeyFinder, scrub: Scrub): SessionKeys {
  const maybe = (text: string | undefined): string | undefined =>
    text === undefined ? undefined : scrub(text);
  return {
    id: scrub(printableId(result.id, finder)),
    hits: result.hits.map((hit) => {
      const place = hit.place;
      const then = place.then;
      const subagent =
        hit.subagent === undefined ? undefined : scrub(printableId(hit.subagent, finder));
      const tool = maybe(place.tool);
      const detail = maybe(place.detail);
      const host = maybe(place.host);
      const service = maybe(place.service);
      const evidence =
        place.evidence === undefined
          ? undefined
          : sanitizeEvidence(place.evidence as Evidence, finder, scrub);
      return {
        ...hit,
        place: {
          ...place,
          ...(tool === undefined ? {} : { tool }),
          ...(detail === undefined ? {} : { detail }),
          ...(host === undefined ? {} : { host }),
          ...(service === undefined ? {} : { service }),
          ...(evidence === undefined ? {} : { evidence }),
          ...(then === undefined
            ? {}
            : {
                then: {
                  ...then,
                  host: then.host === null ? null : scrub(then.host),
                  ...(then.detail === undefined ? {} : { detail: scrub(then.detail) }),
                },
              }),
        },
        at: hit.at,
        ...(subagent === undefined ? {} : { subagent }),
      };
    }),
  };
}

/**
 * A kept result as the reduced session the findings are merged from; `indexOf` turns numbers into
 * places. Only what happened inside the window counts: a key's hits that were last seen before
 * `startMs` are left out, and its farthest hit that remains stands for it. (`seen` and `later` are
 * over the whole session; the time a hit gives is its first in the window.)
 */
export function summaryOf(
  result: SessionKeys,
  indexOf: readonly number[],
  session: SessionInfo,
  startMs: number,
): SessionKeySummary {
  const best = new Map<number, StoredHit>();
  for (const hit of result.hits) {
    const index = indexOf[hit.k];
    if (index === undefined || !isInside(hit.last, startMs)) continue;
    const held = best.get(index);
    if (held === undefined || placeRank(hit.place as Place) < placeRank(held.place as Place))
      best.set(index, hit);
  }
  const keys = new Map<number, KeyInSession>();
  for (const [index, hit] of best) {
    // The first time is outside the window when only a later sighting in this place is inside it.
    const first = isInside(hit.at, startMs);
    keys.set(index, {
      sighting: {
        key: index,
        place: hit.place as Place,
        at: first ? hit.at : hit.last,
        ...(hit.subagent === undefined ? {} : { subagent: hit.subagent }),
        ...(hit.later > 0 ? { laterNetwork: hit.later } : {}),
      },
      times: first ? hit.times : 1,
      seen: hit.seen,
      later: hit.later,
    });
  }
  return { session: { ...session, id: result.id }, keys };
}

/** The findings of the sessions, merged in the order given, with names that may not be printed hidden. */
export function findingsOf(
  keys: readonly Key[],
  finder: KeyFinder,
  summaries: readonly SessionKeySummary[],
): Finding[] {
  return collectFromSummaries(keys, summaries).map((f) => printableFinding(f, finder));
}

/**
 * One finding for each key in each session it was found in, for the places a moment is made from: a key
 * sent in several sessions is in each, with that session's own place. Only the keys that left this machine,
 * the keys a request may have sent without holding them, and the keys the AI saw are kept, and the last
 * two only while no place more external was reached: a key is told by the most external place it
 * reached, as `findingsOf` tells it. Each finding says
 * which session of the window it is from, by its number, since a session's printed name may be hidden.
 * The order is the one findings are listed in.
 */
export function findingsBySession(
  keys: readonly Key[],
  finder: KeyFinder,
  numbered: readonly (readonly [number, SessionKeySummary])[],
): PlacedFinding[] {
  const farthest = new Map<number, Place>();
  for (const [, { keys: seen }] of numbered)
    for (const [index, one] of seen) {
      const held = farthest.get(index);
      if (held === undefined || placeRank(one.sighting.place) < placeRank(held))
        farthest.set(index, one.sighting.place);
    }
  /** Whether a place is told in a moment, given the farthest place its key reached anywhere. */
  const told = (place: Place, reached: Place | undefined): boolean => {
    if (place.tier === 'third_party') return true;
    // A maybe that names where it may have gone (a request that did not hold the key but ran where it
    // was, a file the AI wrote that a request named by its folder, ...): only while nothing sent it.
    if (mayHaveSent(place)) return reached?.tier === 'maybe';
    return place.tier === 'seen' && reached?.tier === 'seen';
  };
  const found: PlacedFinding[] = [];
  for (const [sessionNo, { session, keys: seen }] of numbered)
    for (const [index, one] of seen) {
      if (!told(one.sighting.place, farthest.get(index))) continue;
      const [finding] = collectFromSummaries(keys, [{ session, keys: new Map([[index, one]]) }]);
      if (finding !== undefined) found.push({ ...printableFinding(finding, finder), sessionNo });
    }
  return found.sort(compareFindings);
}
