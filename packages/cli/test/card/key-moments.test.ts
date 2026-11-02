import { describe, expect, it } from 'vitest';
import { buildMoments } from '../../src/card/moments.js';
import { momentSchema } from '../../src/card/schema.js';
import type { PlacedFinding } from '../../src/card/key-moments.js';
import type { Place } from '../../src/sent/place.js';

/**
 * One moment for what happened once: ten keys sent to one host in one session, or ten keys the AI saw in
 * one session, are one moment that lists the keys, not ten that push everything else off the card. When
 * the program that sent them is ssh, scp, sftp or rsync the words say the host may be the user's own server;
 * that only changes the words.
 */

const HOME = '/Users/dev';
const path = (n: number): string => `/Users/dev/.claude/projects/-w/sess-${n}.jsonl`;

const finding = (
  n: number,
  name: string,
  place: Place,
  over: Partial<PlacedFinding> = {},
): PlacedFinding => ({
  sessionNo: n,
  tier: place.tier,
  name,
  source: `/Users/dev/app${n}/.env`,
  provider: 'Other',
  rotate: null,
  place,
  at: `2026-10-20T10:0${n % 10}:00.000Z`,
  session: { agent: 'claude-code', id: `sess-${n}`, path: path(n), cwd: '/Users/dev/shop' },
  times: 1,
  sessions: 1,
  seen: 1,
  ...over,
});

const sent = (host = 'hooks.example.invalid', detail = 'curl'): Place => ({
  tier: 'third_party',
  route: detail === 'curl' ? 'command' : 'ssh',
  tool: 'Bash',
  detail,
  host,
});
const seen = (): Place => ({
  tier: 'seen',
  route: 'result',
  tool: 'Read',
  detail: '/Users/dev/shop/.env',
});

const names = (count: number, prefix = 'KEY'): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}_${i + 1}`);

const build = (findings: PlacedFinding[]) =>
  buildMoments({ told: [], findings, repos: [], home: HOME });
const rowsOf = (m: {
  groups: readonly { rows: readonly (readonly [string, string])[] }[];
}): string => m.groups.flatMap((g) => g.rows.map(([k, v]) => `${k}: ${v}`)).join('\n');

describe('keys sent over ssh, scp, sftp or rsync', () => {
  it('are one moment for ten keys to one server in one session, with the words for a server', () => {
    const moments = build(names(10).map((n) => finding(1, n, sent('89.46.33.147', 'scp'))));
    expect(moments).toHaveLength(1);
    const [m] = moments;
    expect(m?.kind).toBe('key-sent');
    expect(m?.line).toBe(
      'Your agent sent 10 keys to 89.46.33.147 over ssh. If that server is yours, nothing to do; if not, treat them as leaked.',
    );
    for (const n of names(10)) expect(rowsOf(m as never)).toContain(n);
    expect(rowsOf(m as never)).toContain('89.46.33.147, over scp');
    expect(momentSchema.safeParse(m).success).toBe(true);
  });

  it.each(['ssh', 'scp', 'sftp', 'rsync'])('say it for %s, for one key too', (program) => {
    const [m] = build([finding(1, 'STRIPE_SECRET_KEY', sent('203.0.113.7', program))]);
    expect(m?.line).toBe(
      'Your agent sent STRIPE_SECRET_KEY to 203.0.113.7 over ssh. If that server is yours, nothing to do; if not, treat that key as leaked.',
    );
  });

  it('are a moment for each session and each host', () => {
    const moments = build([
      finding(1, 'A_KEY', sent('203.0.113.7', 'scp')),
      finding(1, 'B_KEY', sent('203.0.113.8', 'scp')),
      finding(2, 'C_KEY', sent('203.0.113.7', 'scp')),
    ]);
    expect(moments).toHaveLength(3);
  });

  it('are not mixed with a request to the same host: the words follow the program', () => {
    const moments = build([
      finding(1, 'A_KEY', sent('203.0.113.7', 'scp')),
      finding(1, 'B_KEY', sent('203.0.113.7', 'curl')),
    ]);
    expect(moments.map((m) => m.line)).toEqual([
      'Your agent sent A_KEY to 203.0.113.7 over ssh. If that server is yours, nothing to do; if not, treat that key as leaked.',
      'Your agent sent B_KEY to 203.0.113.7. Treat that key as leaked.',
    ]);
  });

  it('lists the keys it can fit and counts the rest', () => {
    const [m] = build(names(40).map((n) => finding(1, n, sent('89.46.33.147', 'ssh'))));
    expect(momentSchema.safeParse(m).success).toBe(true);
    expect(rowsOf(m as never)).toContain('KEY_1');
    expect(rowsOf(m as never)).toContain('and 25 more');
    expect(m?.line).toContain('40 keys');
  });

  it('say where each key was kept', () => {
    const [m] = build([
      finding(1, 'A_KEY', sent('89.46.33.147', 'scp'), { source: '/Users/dev/app1/.env' }),
      finding(1, 'B_KEY', sent('89.46.33.147', 'scp'), { source: '/Users/dev/app2/.env' }),
    ]);
    const shown = rowsOf(m as never);
    expect(shown).toContain('A_KEY, kept in ~/app1/.env');
    expect(shown).toContain('B_KEY, kept in ~/app2/.env');
  });
});

describe('keys sent to another company by anything else', () => {
  it('are one moment for several keys to one host in one session', () => {
    const moments = build(names(4).map((n) => finding(1, n, sent())));
    expect(moments).toHaveLength(1);
    expect(moments[0]?.line).toBe(
      'Your agent sent 4 keys to hooks.example.invalid. Treat them as leaked.',
    );
    expect(rowsOf(moments[0] as never)).toContain('KEY_4');
  });

  it('keep one key as it was said', () => {
    const [m] = build([finding(1, 'AWS_SECRET_ACCESS_KEY', sent())]);
    expect(m?.line).toBe(
      'Your agent sent AWS_SECRET_ACCESS_KEY to hooks.example.invalid. Treat that key as leaked.',
    );
    expect(rowsOf(m as never)).toContain('Key: AWS_SECRET_ACCESS_KEY');
  });

  it('are a moment for each host and each session', () => {
    const moments = build([
      finding(1, 'A_KEY', sent('one.example.invalid')),
      finding(1, 'B_KEY', sent('two.example.invalid')),
      finding(2, 'C_KEY', sent('one.example.invalid')),
    ]);
    expect(moments).toHaveLength(3);
  });

  it('name another company when the host was not read', () => {
    const noHost: Place = { tier: 'third_party', route: 'command', tool: 'Bash', detail: 'curl' };
    expect(build([finding(1, 'A_KEY', noHost)])[0]?.line).toBe(
      'Your agent sent A_KEY to another company. Treat that key as leaked.',
    );
  });
});

describe('keys the AI saw', () => {
  it('are one moment for ten keys in one session', () => {
    const moments = build(names(10).map((n) => finding(1, n, seen())));
    expect(moments).toHaveLength(1);
    expect(moments[0]?.kind).toBe('key-seen');
    expect(moments[0]?.line).toBe('The AI saw 10 keys in one session in ~/shop.');
    expect(rowsOf(moments[0] as never)).toContain('KEY_10');
  });

  it('keep one key as it was said', () => {
    const [m] = build([finding(1, 'AWS_SECRET_ACCESS_KEY', seen())]);
    expect(m?.line).toBe('Your agent read .env in ~/shop; the AI saw AWS_SECRET_ACCESS_KEY.');
  });

  it('are a moment for each session', () => {
    const moments = build([finding(1, 'A_KEY', seen()), finding(2, 'B_KEY', seen())]);
    expect(moments).toHaveLength(2);
  });
});

describe('what the moments leave room for', () => {
  it('lets ten keys sent in one session leave the card its other moments', () => {
    const moments = build([
      ...names(10).map((n) => finding(1, n, sent('89.46.33.147', 'scp'))),
      ...names(10, 'SEEN').map((n) => finding(2, n, seen())),
    ]);
    expect(moments.map((m) => m.kind)).toEqual(['key-sent', 'key-seen']);
  });

  it('puts keys sent before keys seen', () => {
    const moments = build([finding(3, 'SEEN_KEY', seen()), finding(1, 'SENT_KEY', sent())]);
    expect(moments.map((m) => m.kind)).toEqual(['key-sent', 'key-seen']);
  });
});

describe('a key found in several places', () => {
  const gh = (): Place => ({
    tier: 'third_party',
    route: 'post',
    tool: 'Bash',
    detail: 'gh',
    host: 'api.github.com',
  });

  it("is in the moment of each session and host: three keys scp'd in one session, one posted in another", () => {
    // The findings are one for each key in each session it was found in.
    const moments = build([
      finding(1, 'K1', sent('203.0.113.7', 'scp')),
      finding(1, 'K2', sent('203.0.113.7', 'scp')),
      finding(1, 'K3', sent('203.0.113.7', 'scp')),
      finding(2, 'K1', gh()),
    ]);
    expect(moments.map((m) => m.kind)).toEqual(['key-sent', 'key-sent']);
    const [a, b] = moments;
    expect(a?.line).toBe(
      'Your agent sent 3 keys to 203.0.113.7 over ssh. If that server is yours, nothing to do; if not, treat them as leaked.',
    );
    expect(a?.session?.id).toBe('sess-1');
    for (const k of ['K1', 'K2', 'K3']) expect(rowsOf(a as never)).toContain(`${k}, kept in `);
    expect(b?.line).toBe('Your agent sent K1 to api.github.com. Treat that key as leaked.');
    expect(b?.session?.id).toBe('sess-2');
    expect(rowsOf(b as never)).toContain('Key: K1');
    expect(rowsOf(b as never)).not.toContain('K2');
    expect(rowsOf(b as never)).not.toContain('K3');
    expect(rowsOf(b as never)).toContain('api.github.com, posted by a gh command');
  });

  it('puts a moment with a decoy first, then the oldest', () => {
    const moments = build([
      finding(3, 'C_KEY', sent('three.example.invalid')),
      finding(1, 'A_KEY', sent('one.example.invalid')),
      finding(2, 'B_KEY', sent('two.example.invalid'), { canary: true }),
    ]);
    expect(moments.map((m) => m.session?.id)).toEqual(['sess-2', 'sess-1', 'sess-3']);
  });

  it('keeps the other places out of a moment: a moment lists only the keys found in its session', () => {
    const moments = build([
      finding(1, 'K1', sent('one.example.invalid')),
      finding(2, 'K2', sent('one.example.invalid')),
      finding(2, 'K1', sent('two.example.invalid')),
    ]);
    const lists = moments.map((m) => rowsOf(m as never));
    expect(moments).toHaveLength(3);
    expect(lists.filter((l) => l.includes('K1')).length).toBe(2);
    expect(lists.filter((l) => l.includes('K2')).length).toBe(1);
  });
});

describe('sessions whose names are hidden', () => {
  const hidden = (n: number, name: string, host: string, over: Partial<PlacedFinding> = {}) =>
    finding(n, name, sent(host), {
      session: {
        agent: 'claude-code',
        id: '[an id that cannot be printed]',
        path: '[a name that holds a key]',
        cwd: '[a name that holds a key]',
      },
      ...over,
    });

  it('are not one session because they read the same: each is a moment', () => {
    const moments = build([
      hidden(1, 'A_KEY', 'api.github.com'),
      hidden(2, 'B_KEY', 'api.github.com'),
      hidden(3, 'C_KEY', 'api.github.com'),
    ]);
    expect(moments).toHaveLength(3);
    expect(moments.map((m) => rowsOf(m as never).includes('A_KEY'))).toEqual([true, false, false]);
  });

  it('are one moment for the keys of one session', () => {
    const moments = build([
      hidden(1, 'A_KEY', 'api.github.com'),
      hidden(1, 'B_KEY', 'api.github.com'),
      hidden(2, 'C_KEY', 'api.github.com'),
    ]);
    expect(moments).toHaveLength(2);
    expect(moments[0]?.line).toContain('2 keys');
  });

  it('are told apart for the keys the AI saw too', () => {
    const saw = (n: number, name: string) =>
      finding(n, name, seen(), {
        session: {
          agent: 'claude-code',
          id: '[an id that cannot be printed]',
          path: '[a name that holds a key]',
          cwd: null,
        },
      });
    expect(build([saw(1, 'A_KEY'), saw(2, 'B_KEY')])).toHaveLength(2);
  });
});
