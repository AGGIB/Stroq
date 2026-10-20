import { describe, expect, it } from 'vitest';
import type { Sighting } from '../../src/sent/analyze.js';
import { collectFindings, type SessionInfo } from '../../src/sent/findings.js';
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
