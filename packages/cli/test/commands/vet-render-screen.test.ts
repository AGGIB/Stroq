import { describe, expect, it } from 'vitest';
import { renderCard } from '../../src/commands/vet-card.js';
import { renderPassport } from '../../src/commands/vet-render.js';
import type { Passport } from '../../src/install/types.js';
import { BLIND, many, passportWith } from '../helpers/vet-passport.js';
import { RAW_UNSAFE } from '../helpers/vet-world.js';

describe('the size of the screen', () => {
  it('shows every line of a small passport, and no line about lines left out', () => {
    const out = renderPassport(
      passportWith(many(8, (i) => ({ subject: `s${i}`, sensitive: i < 3 }))),
    );

    expect(out).not.toContain('not shown');
    for (let i = 0; i < 8; i += 1) expect(out).toContain(`s${i} `);
  });

  it('keeps to about 25 lines for a passport with a hundred, and says how many it left out and that --json lists them', () => {
    const passport = passportWith(
      many(100, (i) => ({ subject: `item-${i}`, sensitive: i % 4 === 0 })),
    );
    const out = renderPassport(passport);
    const lines = out.trimEnd().split('\n');

    expect(lines.length).toBeLessThanOrEqual(25);
    const more = lines.find((line) => line.includes('not shown')) ?? '';
    expect(more).toMatch(/and \d+ more lines not shown/);
    expect(more).toContain('--json');
    const shown = lines.filter((line) => line.startsWith('  [')).length;
    expect(Number(/and (\d+) more/.exec(more)?.[1]) + shown).toBe(100);
  });

  it('hides the lines that are not sensitive before the ones that are, and counts what it hides', () => {
    const passport = passportWith([
      ...many(40, (i) => ({ subject: `sensitive-${i}`, sensitive: true })),
      ...many(5, (i) => ({ subject: `plain-${i}`, sensitive: false })),
    ]);
    const out = renderPassport(passport);
    const more = out.split('\n').find((line) => line.includes('not shown')) ?? '';
    const shown = out.split('\n').filter((line) => line.startsWith('  [')).length;

    expect(out).toContain('SENSITIVE (40)');
    expect(out).not.toContain('plain-0');
    expect(out).toContain('sensitive-0');
    // No heading stands over nothing: what is left out is told by the line about it.
    expect(out).not.toContain('OTHER (');
    expect(more).toContain(`(${40 - shown} sensitive, 5 other)`);
  });

  it('puts the lines that are not sensitive under a heading of their own once the sensitive ones are all shown', () => {
    const passport = passportWith([
      ...many(3, (i) => ({ subject: `sensitive-${i}`, sensitive: true })),
      ...many(30, (i) => ({ subject: `plain-${i}`, sensitive: false })),
    ]);
    const out = renderPassport(passport);
    const more = out.split('\n').find((line) => line.includes('not shown')) ?? '';

    expect(out).toContain('SENSITIVE (3)');
    expect(out).toContain('OTHER (30)');
    expect(out.indexOf('OTHER (30)')).toBeGreaterThan(out.indexOf('sensitive-2'));
    expect(out).toContain('plain-0');
    expect(more).toMatch(/\(\d+ other\)/);
    expect(more).not.toContain('sensitive');
  });

  it('prints every blind spot however many there are, and still shows a few lines', () => {
    const spots = Array.from(
      { length: 30 },
      (_, i) => `blind spot number ${String(i).padStart(2, '0')}`,
    );
    const passport = passportWith(
      many(20, (i) => ({ subject: `item-${i}`, sensitive: true })),
      {
        blindSpots: spots,
      },
    );
    const out = renderPassport(passport);

    for (const spot of spots) expect(out).toContain(`- ${spot}`);
    expect(out).toContain('BLIND SPOTS (30)');
    expect(out.split('\n').filter((line) => line.startsWith('  [')).length).toBeGreaterThanOrEqual(
      5,
    );
  });

  it('prints a blind spot that is a hundred characters long on one line, whole', () => {
    const long = 'x'.repeat(100);
    const out = renderPassport(passportWith([], { blindSpots: [long] }));

    expect(out).toContain(`  - ${long}\n`);
  });
});

describe('the signals, the blind spots and the closing sentence', () => {
  it('counts the signals and names the rules, the most frequent first, a few of them', () => {
    const signals = [
      ...many(3, () => ({ ruleId: 'process-spawn', file: 'a.js' })),
      ...many(2, () => ({ ruleId: 'eval', file: 'b.js' })),
      { ruleId: 'declared-name-differs', file: 'package.json' },
      { ruleId: 'obfuscated', file: 'c.js' },
      { ruleId: 'native', file: 'd.node' },
    ];
    const out = renderPassport(passportWith([], { signals }));

    expect(out).toContain(
      'SIGNALS (8): process-spawn x3, eval x2, declared-name-differs, and 2 more rules',
    );
  });

  it('says none were seen, as a reading and not as a promise', () => {
    expect(renderPassport(passportWith([]))).toContain('SIGNALS: none seen (static)');
  });

  it('puts a heading and the blind spots after the signals, and the closing sentence last', () => {
    const out = renderPassport(passportWith([{ subject: 'x', sensitive: true }]));
    const lines = out.split('\n');

    expect(lines.at(-1)).toBe('');
    expect(lines.at(-2)).toBe(
      'This is a reading of the files, not a security certificate: an absent line means nothing was seen, not that nothing is there.',
    );
    expect(lines.at(-3)).toBe('');
    expect(out.indexOf('SIGNALS')).toBeLessThan(out.indexOf('BLIND SPOTS'));
    expect(out.indexOf('BLIND SPOTS (3)')).toBeGreaterThan(out.indexOf('SENSITIVE'));
  });

  it('says it is incomplete, with the name of the reading that failed, above the lines', () => {
    const passport = passportWith([{ subject: 'x', sensitive: true }], {
      signals: [{ ruleId: 'reading-failed:markdown', file: '.' }],
    });
    const out = renderPassport(passport);

    expect(out).toContain(
      'INCOMPLETE: the reading "markdown" (shell blocks and inline commands in documents) failed, and what it finds is missing',
    );
    expect(out.indexOf('INCOMPLETE')).toBeLessThan(out.indexOf('SENSITIVE'));
  });
});

describe("text that is not the screen's own", () => {
  const HOSTILE = '\u001b[2J\u202eevil\u009b31m\u0007\u200b';
  const hostile = (): Passport =>
    ({
      ...passportWith([]),
      artifact: { ...passportWith([]).artifact, name: `n${HOSTILE}`, version: `1${HOSTILE}` },
      lines: [
        {
          kind: 'exec',
          subject: `cmd${HOSTILE}`,
          basis: 'observed',
          sensitive: true,
          where: [{ file: `f${HOSTILE}.sh`, line: 1 }],
          detector: `d${HOSTILE}`,
        },
      ],
      blindSpots: [`spot${HOSTILE}`],
      signals: [{ ruleId: `rule${HOSTILE}`, file: `s${HOSTILE}` }],
    }) as unknown as Passport;

  it('is written out as escapes on the screen, in every place a passport has a string', () => {
    const out = renderPassport(hostile());

    expect(RAW_UNSAFE.test(out)).toBe(false);
    expect(out).toContain('\\u001b');
    expect(out).toContain('\\u202e');
    expect(out).toContain('\\u009b');
  });

  it('is not in the card either, which holds the name and the counts', () => {
    const card = renderCard(hostile());

    expect(RAW_UNSAFE.test(card)).toBe(false);
    expect(card).not.toContain('cmd');
    expect(card).not.toContain('rule\\u');
  });

  it('does not let a line break in a subject make a second row', () => {
    const passport = {
      ...passportWith([]),
      lines: [
        {
          kind: 'exec',
          subject: 'one\ntwo\r\nthree\tfour',
          basis: 'observed',
          sensitive: false,
          where: [{ file: 'x\ny', line: 1 }],
          detector: 'd',
        },
      ],
    } as unknown as Passport;
    const rows = renderPassport(passport)
      .split('\n')
      .filter((line) => line.startsWith('  ['));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('one\\ntwo');
  });
});
