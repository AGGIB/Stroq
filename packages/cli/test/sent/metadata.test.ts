import { describe, expect, it } from 'vitest';
import type { Sighting } from '../../src/sent/analyze.js';
import { collectFindings, type SessionInfo } from '../../src/sent/findings.js';
import { keyFinder, type Key } from '../../src/sent/keys.js';
import { sessionsRead } from '../../src/sent/report.js';
import { ID_NOT_SHOWN, printableSession } from '../../src/sent/run.js';
import type { SessionRef } from '../../src/sent/sessions.js';

/**
 * What a session's records say of themselves (a time, a session id, a subagent's id) reaches the
 * report only in a shape of its own: a time as ISO 8601 or nothing, an id of plain characters that
 * holds no piece of a key. Every value is made up.
 */

const KEY: Key = {
  name: 'K',
  source: '/w/.env',
  value: ['sk', 'live', 'FAKEmetaData0123456789abcdef'].join('_'),
};
const PIECE = KEY.value.slice(8, 24);
const session: SessionInfo = { agent: 'claude-code', id: 's1', path: '/p/s1.jsonl', cwd: '/w' };
const sighting = (at: string, extra: Partial<Sighting> = {}): Sighting => ({
  key: 0,
  place: { tier: 'seen', route: 'prompt' },
  at,
  ...extra,
});

describe('a time a record gives', () => {
  it('is printed as ISO 8601, or not at all', () => {
    const at = (raw: string) =>
      collectFindings([KEY], [{ session, sightings: [sighting(raw)] }])[0]?.at;
    expect(at(`Sun Oct 11 2026 14:00:00 GMT+0000 (${PIECE})`)).toBe('2026-10-11T14:00:00.000Z');
    expect(at(`2026-10-11T14:00:00Z (${PIECE})`)).toBeNull();
    expect(at('')).toBeNull();
    expect(at('2026-10-11T14:00:00Z')).toBe('2026-10-11T14:00:00.000Z');
  });

  it('the time of what became of a written file too', () => {
    const [f] = collectFindings(
      [KEY],
      [
        {
          session,
          sightings: [
            sighting('2026-10-11T14:00:00Z', {
              place: {
                tier: 'maybe',
                route: 'write-push',
                then: {
                  route: 'git-push',
                  host: null,
                  at: `Sun Oct 11 2026 15:00:00 GMT+0000 (${PIECE})`,
                },
              },
            }),
          ],
        },
      ],
    );
    expect(f?.place.then?.at).toBe('2026-10-11T15:00:00.000Z');
  });

  it('the first and oldest times of the sessions read', () => {
    const ref: SessionRef = {
      agent: 'claude-code',
      path: '/p/s1.jsonl',
      files: [],
      cwd: null,
      first: `Sun Oct 11 2026 14:00:00 GMT+0000 (${PIECE})`,
      mtimeMs: 0,
    };
    const read = sessionsRead([ref]);
    expect(read.first).toBe('2026-10-11T14:00:00.000Z');
    expect(read.agents['claude-code']?.oldest).toBe('2026-10-11T14:00:00.000Z');
    expect(JSON.stringify(read)).not.toContain(PIECE);
  });
});

describe('an id a record gives', () => {
  const finder = keyFinder([KEY]);

  it('is kept when it has the shape of one and holds no piece of a key', () => {
    expect(
      printableSession({ ...session, id: 'a1b2-c3:d4.e5_f6' }, undefined, finder),
    ).toMatchObject({
      session: { id: 'a1b2-c3:d4.e5_f6' },
    });
  });

  it.each([
    ['a piece of a key', `id-${PIECE}-id`],
    ['a blank', 'two words'],
    ['a terminal escape', 'id\u001b[2J'],
    ['too long', 'x'.repeat(65)],
    ['empty', ''],
  ])('is a fixed label when it holds %s', (_how, id) => {
    expect(printableSession({ ...session, id }, undefined, finder).session.id).toBe(ID_NOT_SHOWN);
  });

  it('the id of a subagent is held to the same shape', () => {
    expect(printableSession(session, `a-${PIECE}`, finder).subagent).toBe(ID_NOT_SHOWN);
    expect(printableSession(session, 'agent-1', finder).subagent).toBe('agent-1');
  });
});
