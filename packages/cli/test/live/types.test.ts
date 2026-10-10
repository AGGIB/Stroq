import { describe, expect, it } from 'vitest';
import {
  HOST_STATES,
  LIVE_OUTCOMES,
  PROBE_MARKS,
  parseHostResult,
  type HostResult,
} from '../../src/live/types.js';
import { DIGEST, armedControl, resultOf, validResult } from './helpers.js';

/**
 * The stored result is read back by `stroq doctor` and printed. A file that has been edited by hand, or
 * written by a newer Stroq, must read as "no result" and never as a partial one, so the schema is
 * strict: nothing it does not name gets through, and every string that could reach a terminal is plain
 * printable ASCII of a bounded length.
 */
const asRaw = (result: HostResult): Record<string, unknown> =>
  JSON.parse(JSON.stringify(result)) as Record<string, unknown>;

/** A copy of the valid result as parsed JSON, with one thing changed. */
const withChange = (change: (raw: Record<string, any>) => void): unknown => {
  const raw = asRaw(validResult());
  change(raw);
  return raw;
};

describe('the vocabulary', () => {
  it('names the eight states of a host, and four of them are what a live check can end in', () => {
    expect([...HOST_STATES]).toEqual([
      'installed',
      'observed',
      'verified',
      'stale',
      'failed',
      'inconclusive',
      'not-attempted',
      'unsupported',
    ]);
    expect([...LIVE_OUTCOMES]).toEqual(['verified', 'failed', 'inconclusive', 'not-attempted']);
    for (const outcome of LIVE_OUTCOMES) expect(HOST_STATES).toContain(outcome);
  });

  it('names the marks a probe can get', () => {
    expect([...PROBE_MARKS]).toEqual([
      'passed',
      'failed',
      'not-issued',
      'inconclusive',
      'skipped',
      'not-attempted',
    ]);
  });
});

describe('parseHostResult', () => {
  it('takes a well-formed result and hands back what was in it', () => {
    const parsed = parseHostResult(asRaw(validResult()));
    expect(parsed).toEqual({ ok: true, result: validResult() });
  });

  it('takes a host whose version is not known, a probe without a reason, and no probes at all', () => {
    const raw = asRaw(
      validResult({
        hostVersion: null,
        probes: [
          {
            id: 'allow',
            kind: 'allow',
            mark: 'not-attempted',
            evidence: { E1: null, E2: null, E3: null, E4: null },
          },
        ],
        state: 'not-attempted',
      }),
    );
    expect(parseHostResult(raw)).toMatchObject({ ok: true });
    expect(parseHostResult({ ...raw, probes: [] })).toMatchObject({ ok: true });
  });

  it('keeps the detail a probe carries, and takes a probe that has none', () => {
    const detailed = validResult({
      probes: [
        {
          id: 'deny',
          kind: 'deny',
          mark: 'failed',
          reason: 'policy-mismatch',
          detail: 'the audit says allow (no rule); expected deny (deny-git-exec)',
          evidence: { E1: true, E2: false, E3: false, E4: false },
        },
      ],
      state: 'failed',
    });
    expect(parseHostResult(asRaw(detailed))).toEqual({ ok: true, result: detailed });
  });

  it.each(HOST_STATES.filter((state) => !(LIVE_OUTCOMES as readonly string[]).includes(state)))(
    'refuses the state %s, which is read off the machine and never stored',
    (state) => {
      const parsed = parseHostResult(withChange((raw) => (raw['state'] = state)));
      expect(parsed.ok).toBe(false);
    },
  );

  // Every case below is a file that is not one of Stroq's: it reads as no result, whole.
  const hostile: ReadonlyArray<readonly [string, (raw: Record<string, any>) => void]> = [
    ['version 2', (raw) => (raw['version'] = 2)],
    ['no version', (raw) => delete raw['version']],
    ['a state of its own', (raw) => (raw['state'] = 'safe')],
    ['a state that is not a string', (raw) => (raw['state'] = 1)],
    ['a mode of its own', (raw) => (raw['mode'] = 'real')],
    ['an extra key at the top', (raw) => (raw['trusted'] = true)],
    ['an extra key in a probe', (raw) => (raw['probes'][0]['note'] = 'x')],
    ['an extra key in the evidence', (raw) => (raw['probes'][0]['evidence']['E5'] = true)],
    ['a missing E4', (raw) => delete raw['probes'][0]['evidence']['E4']],
    ['evidence that is a string', (raw) => (raw['probes'][0]['evidence']['E1'] = 'true')],
    ['a mark of its own', (raw) => (raw['probes'][0]['mark'] = 'blocked')],
    ['a kind of its own', (raw) => (raw['probes'][0]['kind'] = 'shell')],
    ['a reason with a space', (raw) => (raw['probes'][0]['reason'] = 'not issued')],
    ['a reason in capitals', (raw) => (raw['probes'][0]['reason'] = 'Not-Issued')],
    ['a probe id that is a path', (raw) => (raw['probes'][0]['id'] = '../deny')],
    ['a digest that is short', (raw) => (raw['policySha256'] = 'abc123')],
    ['a digest in capitals', (raw) => (raw['policySha256'] = DIGEST.toUpperCase())],
    ['a digest that is not hex', (raw) => (raw['policySha256'] = 'z'.repeat(64))],
    ['a time without milliseconds', (raw) => (raw['at'] = '2026-10-10T01:02:03Z')],
    ['a time with an offset', (raw) => (raw['at'] = '2026-10-10T01:02:03.456+05:00')],
    ['a time in other words', (raw) => (raw['at'] = 'Oct 10 2026 01:02:03 UTC')],
    ['a day that does not exist', (raw) => (raw['at'] = '2026-02-31T01:02:03.456Z')],
    ['an agent that is a path', (raw) => (raw['agent'] = '../claude-code')],
    ['an agent in capitals', (raw) => (raw['agent'] = 'Claude-Code')],
    ['an empty agent', (raw) => (raw['agent'] = '')],
    ['a host version with a newline', (raw) => (raw['hostVersion'] = '2.1.271\nfake line')],
    ['a host version with an escape', (raw) => (raw['hostVersion'] = '2.1.271\u001b[2J')],
    ['a host version that is not ASCII', (raw) => (raw['hostVersion'] = '２.1.271')],
    ['a host version of 81 characters', (raw) => (raw['hostVersion'] = 'v'.repeat(81))],
    ['a Stroq version that is null', (raw) => (raw['stroqVersion'] = null)],
    ['17 probes', (raw) => (raw['probes'] = Array.from({ length: 17 }, () => raw['probes'][0]))],
    ['probes that are not a list', (raw) => (raw['probes'] = {})],
    ['17 caveats', (raw) => (raw['caveats'] = Array.from({ length: 17 }, () => 'caveat'))],
    ['a caveat with a control character', (raw) => (raw['caveats'] = ['a\u0007b'])],
    ['a caveat of 121 characters', (raw) => (raw['caveats'] = ['c'.repeat(121)])],
    ['a detail with a control character', (raw) => (raw['probes'][0]['detail'] = 'a\u001bb')],
    ['a detail of 161 characters', (raw) => (raw['probes'][0]['detail'] = 'd'.repeat(161))],
  ];

  it.each(hostile)('refuses a result with %s', (_name, change) => {
    expect(parseHostResult(withChange(change)).ok).toBe(false);
  });

  it.each([
    ['null', null],
    ['a string', 'verified'],
    ['a number', 7],
    ['a list', []],
    ['an empty object', {}],
  ])('refuses %s', (_name, raw) => {
    expect(parseHostResult(raw).ok).toBe(false);
  });

  // The state is what the probes come to, and nothing a file can say beside them. A file edited to say
  // verified over probes that did not earn it, or less than they earned, is not a result.
  describe('a state that does not follow from the probes', () => {
    const unfollowed = (change: (raw: Record<string, any>) => void): unknown =>
      parseHostResult(withChange(change));
    const refused = { ok: false, problem: 'state-inconsistent' };

    it('takes the result of each state when its probes come to it', () => {
      for (const state of LIVE_OUTCOMES)
        expect(parseHostResult(asRaw(resultOf(state))), state).toMatchObject({ ok: true });
    });

    it.each<[string, (raw: Record<string, any>) => void]>([
      [
        'verified, and the control run taken out',
        (raw) => (raw['probes'] = raw['probes'].filter((p: any) => !p.id.endsWith(':control'))),
      ],
      [
        'verified, and the control run inconclusive',
        (raw) => (raw['probes'][2]['mark'] = 'inconclusive'),
      ],
      [
        'verified, and the control run for another probe',
        (raw) => (raw['probes'][2]['id'] = 'secret-egress:control'),
      ],
      ['verified, and a probe failed', (raw) => (raw['probes'][1]['mark'] = 'failed')],
      [
        'verified, and the allow did not pass',
        (raw) => (raw['probes'][0]['mark'] = 'inconclusive'),
      ],
      ['verified, and no probes at all', (raw) => (raw['probes'] = [])],
      [
        'verified, and every probe not attempted',
        (raw) => raw['probes'].forEach((p: any) => (p['mark'] = 'not-attempted')),
      ],
      ['failed, and no probe failed', (raw) => (raw['state'] = 'failed')],
      [
        'inconclusive, over probes that earned a verified',
        (raw) => (raw['state'] = 'inconclusive'),
      ],
      ['not-attempted, over probes that passed', (raw) => (raw['state'] = 'not-attempted')],
    ])('refuses a result that says %s', (_name, change) => {
      expect(unfollowed(change)).toEqual(refused);
    });

    it('refuses a failed result that says it is inconclusive, and the other way round', () => {
      expect(parseHostResult({ ...asRaw(resultOf('failed')), state: 'inconclusive' })).toEqual(
        refused,
      );
      expect(parseHostResult({ ...asRaw(resultOf('inconclusive')), state: 'failed' })).toEqual(
        refused,
      );
    });

    it('says only what is wrong, and nothing the file said', () => {
      const parsed = parseHostResult(
        withChange((raw) => {
          raw['caveats'] = ['EVIL caveat'];
          raw['state'] = 'failed';
        }),
      );
      expect(parsed).toEqual(refused);
    });

    it('looks at the format first: a field that is wrong is named, and the state is not asked about', () => {
      const parsed = parseHostResult(
        withChange((raw) => {
          raw['state'] = 'failed';
          raw['probes'][0]['mark'] = 'EVIL';
        }),
      );
      expect(parsed).toEqual({
        ok: false,
        problem: expect.stringContaining('probes.0.mark'),
      });
    });

    it('takes a verified result with a control for the other deny, and with both', () => {
      const both = resultOf('verified', {
        probes: [
          ...resultOf('verified').probes,
          {
            id: 'secret-egress',
            kind: 'secret-egress',
            mark: 'passed',
            reason: 'blocked',
            evidence: { E1: true, E2: true, E3: true, E4: true },
          },
          armedControl('secret-egress', 'secret-egress'),
        ],
      });
      expect(parseHostResult(asRaw(both))).toMatchObject({ ok: true });
    });
  });

  it('refuses a result that names __proto__, however it got there', () => {
    const raw = JSON.parse(
      `${JSON.stringify(asRaw(validResult())).slice(0, -1)},"__proto__":{"state":"verified"}}`,
    ) as unknown;
    expect(parseHostResult(raw).ok).toBe(false);
  });

  it('says the whole file is wrong when it is not even the shape of a result', () => {
    expect(parseHostResult(null)).toEqual({
      ok: false,
      problem: 'does not match the result format (whole file)',
    });
  });

  it('says where the result is wrong, and never repeats what the file said', () => {
    const hostileKey = '\u001b]52;c;ZXZpbA==\u0007';
    const parsed = parseHostResult(
      withChange((raw) => {
        raw[hostileKey] = 1;
        raw['probes'][1]['mark'] = 'EVIL-MARK';
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem).not.toContain('EVIL');
    expect(parsed.problem).not.toContain('ZXZpbA');
    // eslint-disable-next-line no-control-regex
    expect(parsed.problem).toMatch(/^[\x20-\x7e]+$/);
    expect(parsed.problem.length).toBeLessThan(200);
  });

  it('names the field that is wrong', () => {
    const parsed = parseHostResult(withChange((raw) => (raw['probes'][1]['mark'] = 'EVIL')));
    expect(parsed).toEqual({
      ok: false,
      problem: expect.stringContaining('probes.1.mark'),
    });
  });
});
