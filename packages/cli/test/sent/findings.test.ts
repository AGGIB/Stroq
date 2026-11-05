import { describe, expect, it } from 'vitest';
import type { Sighting } from '../../src/sent/analyze.js';
import {
  collectFindings,
  collectFromSummaries,
  isoTime,
  summarizeSightings,
  type SessionInfo,
} from '../../src/sent/findings.js';
import { placeRank, type Place } from '../../src/sent/place.js';
import type { Key } from '../../src/sent/keys.js';

const KEYS: readonly Key[] = [
  { name: 'OPENAI_API_KEY', source: '~/w/.env', value: 'sk-FAKEopenai0123456789abcdef' },
  { name: 'STRIPE_SECRET_KEY', source: '~/shop/.env', value: 'sk_FAKEstripe0123456789abcdef' },
  { name: 'NEVER_SEEN_TOKEN', source: 'env', value: 'FAKEneverSeen0123456789abcd' },
];

const session = (id: string): SessionInfo => ({
  agent: 'claude-code',
  id,
  path: `/h/.claude/projects/x/${id}.jsonl`,
  cwd: '/w',
});

describe('collectFindings', () => {
  it('one finding per key, under the most external tier it reached', () => {
    const a: Sighting[] = [
      {
        key: 0,
        place: { tier: 'seen', route: 'result', tool: 'Read' },
        at: '2026-10-01T10:00:00Z',
      },
      {
        key: 0,
        place: { tier: 'own_service', route: 'command', host: 'api.openai.com' },
        at: '2026-10-01T10:01:00Z',
      },
      { key: 1, place: { tier: 'seen', route: 'prompt' }, at: '2026-10-02T10:00:00Z' },
    ];
    const b: Sighting[] = [
      {
        key: 1,
        place: { tier: 'third_party', route: 'command', host: 'collect.example' },
        at: '2026-10-03T09:00:00Z',
      },
      {
        key: 1,
        place: { tier: 'third_party', route: 'command', host: 'collect.example' },
        at: '2026-10-03T08:00:00Z',
      },
    ];
    const findings = collectFindings(KEYS, [
      { session: session('A'), sightings: a },
      { session: session('B'), sightings: b },
    ]);

    expect(findings.map((f) => [f.name, f.tier, f.times, f.sessions, f.seen])).toEqual([
      ['STRIPE_SECRET_KEY', 'third_party', 2, 2, 3],
      ['OPENAI_API_KEY', 'seen', 1, 1, 2],
    ]);
    const stripe = findings[0];
    expect(stripe?.at).toBe('2026-10-03T08:00:00.000Z');
    expect(stripe?.session.id).toBe('B');
    expect(stripe?.provider).toBe('Stripe');
    expect(stripe?.rotate).toBe('https://dashboard.stripe.com/apikeys');
  });

  it('a key used only with its own service is reported as that', () => {
    const findings = collectFindings(KEYS, [
      {
        session: session('A'),
        sightings: [
          {
            key: 0,
            place: { tier: 'own_service', route: 'command', host: 'api.openai.com' },
            at: '',
          },
        ],
      },
    ]);
    expect(findings.map((f) => f.tier)).toEqual(['own_service']);
  });

  it('a stopped call to another company is not hidden behind the key being seen by the AI', () => {
    const findings = collectFindings(KEYS, [
      {
        session: session('A'),
        sightings: [
          { key: 1, place: { tier: 'seen', route: 'prompt' }, at: '' },
          {
            key: 1,
            place: {
              tier: 'blocked',
              route: 'command',
              host: 'collect.example',
              blocked: 'stroq',
              wouldBe: 'third_party',
            },
            at: '',
          },
        ],
      },
    ]);
    expect(findings.map((f) => [f.tier, f.place.wouldBe])).toEqual([['blocked', 'third_party']]);
  });

  it('holds no value', () => {
    const findings = collectFindings(KEYS, [
      {
        session: session('A'),
        sightings: [{ key: 1, place: { tier: 'seen', route: 'prompt' }, at: '' }],
      },
    ]);
    const text = JSON.stringify(findings);
    for (const key of KEYS) expect(text).not.toContain(key.value);
  });

  it('nothing seen, nothing found', () => {
    expect(collectFindings(KEYS, [{ session: session('A'), sightings: [] }])).toEqual([]);
  });
});

/**
 * The rule the findings were first written by: one sighting at a time, in the order the sessions and the
 * sightings come. `collectFindings` now merges sessions that were reduced one by one, which is what lets a
 * session's result be kept between runs; the two must say the same of any sightings.
 */
describe('merging reduced sessions', () => {
  interface Seq {
    sighting: Sighting;
    session: SessionInfo;
    times: number;
    seen: number;
    sessions: Set<string>;
    later: Map<string, number>;
  }
  const earlier = (a: string, b: string): boolean => {
    const x = Date.parse(a);
    const y = Date.parse(b);
    if (Number.isNaN(y)) return !Number.isNaN(x);
    return !Number.isNaN(x) && x < y;
  };
  function sequential(all: { session: SessionInfo; sightings: Sighting[] }[]): Map<number, Seq> {
    const best = new Map<number, Seq>();
    for (const { session, sightings } of all)
      for (const sighting of sightings) {
        const cur = best.get(sighting.key);
        const n = sighting.laterNetwork ?? 0;
        if (cur === undefined) {
          best.set(sighting.key, {
            sighting,
            session,
            times: 1,
            seen: 1,
            sessions: new Set([session.path]),
            later: new Map(n > 0 ? [[session.path, n]] : []),
          });
          continue;
        }
        cur.sessions.add(session.path);
        cur.seen += 1;
        if (n > (cur.later.get(session.path) ?? 0)) cur.later.set(session.path, n);
        const rank = placeRank(sighting.place) - placeRank(cur.sighting.place);
        if (rank < 0) Object.assign(cur, { sighting, session, times: 1 });
        else if (rank === 0) {
          cur.times += 1;
          if (earlier(sighting.at, cur.sighting.at)) Object.assign(cur, { sighting, session });
        }
      }
    return best;
  }

  const PLACES: Place[] = [
    { tier: 'third_party', route: 'command', host: 'a.invalid' },
    { tier: 'third_party', route: 'command', host: 'b.invalid' },
    { tier: 'maybe', route: 'command-ran', detail: 'node' },
    { tier: 'seen', route: 'result', tool: 'Read' },
    { tier: 'seen', route: 'prompt' },
    { tier: 'own_service', route: 'command', host: 'api.openai.com' },
    { tier: 'blocked', route: 'command', blocked: 'stroq', wouldBe: 'third_party' },
    { tier: 'blocked', route: 'command', blocked: 'user', wouldBe: 'seen' },
  ];
  const TIMES = [
    '',
    'soon',
    '2026-10-01T10:00:00Z',
    '2026-10-01T10:00:00Z',
    '2026-10-02T10:00:00Z',
  ];

  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('gives the findings of the sequential rule for any sightings, kept or not between runs', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const rand = rng(seed);
      const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
      const sessions = Array.from({ length: 1 + Math.floor(rand() * 6) }, (_, i) => ({
        session: session(`S${i}`),
        sightings: Array.from({ length: Math.floor(rand() * 12) }, (): Sighting => {
          const later = Math.floor(rand() * 4);
          return {
            key: Math.floor(rand() * 3),
            place: pick(PLACES),
            at: pick(TIMES),
            ...(later === 0 ? {} : { laterNetwork: later }),
          };
        }),
      }));
      const expected = sequential(sessions);
      // As the card does: each session reduced on its own, then merged in order.
      const reduced = sessions.map((s) => ({
        session: s.session,
        keys: summarizeSightings(s.sightings),
      }));
      const findings = collectFromSummaries(KEYS, reduced);
      expect(findings.length, `seed ${seed}`).toBe(expected.size);
      for (const f of findings) {
        const index = KEYS.findIndex((k) => k.name === f.name);
        const want = expected.get(index) as Seq;
        const counts = [...want.later.values()].filter((n) => n > 0);
        expect(
          {
            tier: f.tier,
            host: f.place.host,
            at: f.at,
            session: f.session.id,
            times: f.times,
            sessions: f.sessions,
            seen: f.seen,
            later: f.laterNetworkCommands,
            laterSessions: f.laterNetworkSessions,
          },
          `seed ${seed} ${f.name}`,
        ).toEqual({
          tier: want.sighting.place.tier,
          host: want.sighting.place.host,
          at: isoTime(want.sighting.at),
          session: want.session.id,
          times: want.times,
          sessions: want.sessions.size,
          seen: want.seen,
          later:
            want.sighting.place.tier === 'seen' && counts.length > 0
              ? counts.reduce((a, b) => a + b, 0)
              : undefined,
          laterSessions:
            want.sighting.place.tier === 'seen' && counts.length > 1 ? counts.length : undefined,
        });
      }
      expect(collectFindings(KEYS, sessions)).toEqual(findings);
    }
  });
});
