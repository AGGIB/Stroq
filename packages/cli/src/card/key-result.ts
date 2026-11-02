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
  isoTime,
  summarizeSightings,
  type Finding,
  type KeyInSession,
  type SessionInfo,
  type SessionKeySummary,
} from '../sent/findings.js';
import type { Key, KeyFinder } from '../sent/keys.js';
import type { Place } from '../sent/place.js';
import { printableFinding, printableId } from '../sent/run.js';
import type { Scrub } from './scrub.js';
import { MAX_HITS, type SessionKeys, type StoredHit } from './key-schema.js';

/** A place with the time of what became of its file as ISO 8601, or null. */
const timed = (place: Place): Place =>
  place.then === undefined
    ? place
    : { ...place, then: { ...place.then, at: isoTime(place.then.at) } };

/** One transcript's sightings as what is kept: one hit per key, in the order the keys were first seen. */
export function hitsOf(sightings: readonly Sighting[], idOf: readonly number[]): StoredHit[] {
  const hits: StoredHit[] = [];
  for (const [key, one] of summarizeSightings(sightings)) {
    const k = idOf[key];
    if (k === undefined) continue;
    hits.push({
      k,
      place: timed(one.sighting.place) as StoredHit['place'],
      at: isoTime(one.sighting.at) ?? '',
      ...(one.sighting.subagent === undefined ? {} : { subagent: one.sighting.subagent }),
      times: one.times,
      seen: one.seen,
      later: one.later,
    });
  }
  return hits;
}

/** Whether a result is small enough to be kept. */
export const fitsKept = (result: SessionKeys): boolean => result.hits.length <= MAX_HITS;

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
      return {
        ...hit,
        place: {
          ...place,
          ...(tool === undefined ? {} : { tool }),
          ...(detail === undefined ? {} : { detail }),
          ...(host === undefined ? {} : { host }),
          ...(service === undefined ? {} : { service }),
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

/** A kept result as the reduced session the findings are merged from; `indexOf` turns numbers into places. */
export function summaryOf(
  result: SessionKeys,
  indexOf: readonly number[],
  session: SessionInfo,
): SessionKeySummary {
  const keys = new Map<number, KeyInSession>();
  for (const hit of result.hits) {
    const index = indexOf[hit.k];
    if (index === undefined) continue;
    keys.set(index, {
      sighting: {
        key: index,
        place: hit.place as Place,
        at: hit.at,
        ...(hit.subagent === undefined ? {} : { subagent: hit.subagent }),
        ...(hit.later > 0 ? { laterNetwork: hit.later } : {}),
      },
      times: hit.times,
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
