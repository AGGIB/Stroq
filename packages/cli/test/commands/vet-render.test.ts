import { describe, expect, it } from 'vitest';
import { renderCard } from '../../src/commands/vet-card.js';
import { renderPassport } from '../../src/commands/vet-render.js';
import { PassportSchema, type CapKind, type Passport } from '../../src/install/types.js';
import { RAW_UNSAFE } from '../helpers/vet-world.js';

/**
 * The screen of `stroq vet` and its card, from a passport and nothing else: no disk, no reader. A passport
 * is built here line by line so that each rule of the screen has a case of its own.
 */
type Spec = {
  readonly kind?: CapKind;
  readonly subject: string;
  readonly sensitive?: boolean;
  readonly basis?: 'declared' | 'observed' | 'limited' | 'unknown';
  readonly where?: readonly { file: string; line: number | null }[];
};

const BLIND = [
  'anything the program fetches, builds or decides at run time was not looked at',
  'code in languages other than JavaScript, TypeScript, Python and shell was not read',
  'nothing was run: this is a reading of the files, and what the program does when it runs was not observed',
];
const DIGEST = 'c'.repeat(64);

function passportWith(
  specs: readonly Spec[],
  rest: {
    readonly name?: string;
    readonly version?: string | null;
    readonly blindSpots?: readonly string[];
    readonly signals?: readonly { ruleId: string; file: string }[];
    readonly kind?: 'skill' | 'mcp' | 'plugin';
    readonly files?: number;
    readonly bytes?: number;
  } = {},
): Passport {
  return PassportSchema.parse({
    schema: 'stroq-passport/1',
    artifact: {
      kind: rest.kind ?? 'skill',
      name: rest.name ?? 'demo',
      version: rest.version ?? null,
      source: { type: 'dir', label: 'demo-folder' },
      digest: DIGEST,
      files: rest.files ?? 3,
      bytes: rest.bytes ?? 1200,
    },
    lines: specs.map((spec) => ({
      kind: spec.kind ?? 'exec',
      subject: spec.subject,
      basis: spec.basis ?? 'observed',
      sensitive: spec.sensitive ?? false,
      where: spec.where ?? [{ file: 'SKILL.md', line: 3 }],
      detector: 'a detector phrase that the screen does not print',
    })),
    blindSpots: rest.blindSpots ?? BLIND,
    signals: rest.signals ?? [],
    imported: [],
    analysis: { stroq: '0.0.0-test', rules: 'test-rules/1' },
  });
}

const many = <T>(count: number, make: (index: number) => T): T[] =>
  Array.from({ length: count }, (_, index) => make(index));

describe('the title and the digest', () => {
  it("says the name and version are the artifact's own words, when a declared line has them", () => {
    const passport = passportWith(
      [
        {
          kind: 'signal',
          subject: 'declared-name: demo 2.0.1',
          basis: 'declared',
          where: [{ file: 'SKILL.md', line: null }],
        },
      ],
      { name: 'demo', version: '2.0.1' },
    );

    expect(renderPassport(passport).split('\n')[0]).toBe(
      'skill demo 2.0.1 (name and version declared by the artifact, not checked)',
    );
  });

  it('says only the name when there is no version, and only the version when the name is the folder', () => {
    const named = passportWith(
      [{ kind: 'signal', subject: 'declared-name: demo', basis: 'declared' }],
      { name: 'demo' },
    );
    const versioned = passportWith(
      [{ kind: 'signal', subject: 'declared-version: 9.9', basis: 'declared' }],
      { name: 'demo-folder', version: '9.9' },
    );
    const bare = passportWith([], { name: 'demo-folder' });

    expect(renderPassport(named).split('\n')[0]).toBe(
      'skill demo (name declared by the artifact, not checked)',
    );
    expect(renderPassport(versioned).split('\n')[0]).toBe(
      'skill demo-folder 9.9 (named after the folder; version declared by the artifact, not checked)',
    );
    expect(renderPassport(bare).split('\n')[0]).toBe('skill demo-folder (named after the folder)');
  });

  it('does not take a name for declared because a line of the same kind says another', () => {
    const passport = passportWith(
      [{ kind: 'signal', subject: 'declared-name: somebody-else', basis: 'declared' }],
      { name: 'demo-folder' },
    );

    expect(renderPassport(passport).split('\n')[0]).toBe(
      'skill demo-folder (named after the folder)',
    );
  });

  it('puts the digest on the second line with the counts, in the singular where it is one', () => {
    const several = renderPassport(passportWith([], { files: 12, bytes: 4096 })).split('\n')[1];
    const one = renderPassport(passportWith([], { files: 1, bytes: 1 })).split('\n')[1];

    expect(several).toBe(`stroq-tree/1 sha256:${DIGEST}  12 files, 4096 bytes`);
    expect(one).toBe(`stroq-tree/1 sha256:${DIGEST}  1 file, 1 byte`);
  });

  it('says the digest is platform-dependent when the passport says the executable bit was not available', () => {
    const passport = passportWith([], {
      blindSpots: [...BLIND, 'executable bit not available on this platform'],
    });

    expect(renderPassport(passport).split('\n')[1]).toBe(
      `stroq-tree/1 sha256:${DIGEST}  3 files, 1200 bytes (platform-dependent: no executable bit)`,
    );
  });

  it('says the digest matches --expect when it is asked to', () => {
    const line = renderPassport(passportWith([]), { matchedExpect: true }).split('\n')[1];

    expect(line).toBe(`stroq-tree/1 sha256:${DIGEST}  3 files, 1200 bytes (matches --expect)`);
  });
});

describe('the lines', () => {
  it('groups them by sensitivity, sensitive first, each group in the order the passport has', () => {
    const passport = passportWith([
      { subject: 'a-plain', sensitive: false },
      { subject: 'b-sensitive', sensitive: true },
      { subject: 'c-plain', sensitive: false },
      { subject: 'd-sensitive', sensitive: true },
    ]);
    const out = renderPassport(passport);

    expect(out).toContain('SENSITIVE (2)');
    expect(out).toContain('OTHER (2)');
    const order = ['b-sensitive', 'd-sensitive', 'a-plain', 'c-plain'].map((s) => out.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((index) => index > 0)).toBe(true);
  });

  it('leaves a group out that has no lines', () => {
    const out = renderPassport(passportWith([{ subject: 'only', sensitive: true }]));

    expect(out).toContain('SENSITIVE (1)');
    expect(out).not.toContain('OTHER (');
  });

  it('writes each line as basis, kind, subject and the first place, in columns', () => {
    const passport = passportWith([
      {
        kind: 'cred.env',
        subject: 'API_KEY',
        sensitive: true,
        basis: 'observed',
        where: [{ file: 'a/b.py', line: 7 }],
      },
      {
        kind: 'allowed-tools',
        subject: 'Bash(ls:*)',
        sensitive: true,
        basis: 'declared',
        where: [{ file: 'SKILL.md', line: null }],
      },
      {
        kind: 'net',
        subject: 'h.example',
        sensitive: true,
        basis: 'unknown',
        where: [
          { file: 'x.js', line: 1 },
          { file: 'y.js', line: 2 },
        ],
      },
      {
        kind: 'tool',
        subject: 't',
        sensitive: true,
        basis: 'limited',
        where: [{ file: 'x.js', line: 1 }],
      },
    ]);
    const rows = renderPassport(passport)
      .split('\n')
      .filter((line) => line.startsWith('  ['));

    expect(rows).toEqual([
      '  [observed] cred.env       API_KEY     a/b.py:7',
      '  [declared] allowed-tools  Bash(ls:*)  SKILL.md',
      '  [unknown]  net            h.example   x.js:1 (+1 more)',
      '  [limited]  tool           t           x.js:1',
    ]);
  });

  it('says plainly that nothing was seen when there is no line, and does not say nothing is there', () => {
    const out = renderPassport(passportWith([]));

    expect(out).toContain('LINES: none seen (static)');
    expect(out).not.toContain('SENSITIVE');
  });

  it('cuts a long subject and a long place, and keeps the end of a path', () => {
    const passport = passportWith([
      { subject: 's'.repeat(300), where: [{ file: `${'d/'.repeat(60)}the-file.sh`, line: 4 }] },
    ]);
    const row =
      renderPassport(passport)
        .split('\n')
        .find((line) => line.startsWith('  [')) ?? '';

    expect(row.length).toBeLessThan(130);
    expect(row).toContain('\u2026');
    expect(row).toMatch(/the-file\.sh:4$/);
  });

  it('cuts text by characters and not by units, so that no half of a pair is left', () => {
    const passport = passportWith([{ subject: '\u{1f600}'.repeat(200) }]);
    const out = renderPassport(passport);

    expect(out).not.toMatch(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
    );
  });
});

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

  it('hides the lines that are not sensitive before the ones that are, and counts the sensitive ones it hides', () => {
    const passport = passportWith([
      ...many(40, (i) => ({ subject: `sensitive-${i}`, sensitive: true })),
      ...many(5, (i) => ({ subject: `plain-${i}`, sensitive: false })),
    ]);
    const out = renderPassport(passport);
    const more = out.split('\n').find((line) => line.includes('not shown')) ?? '';

    expect(out).toContain('SENSITIVE (40)');
    expect(out).toContain('OTHER (5)');
    expect(out).not.toContain('plain-0');
    expect(out).toContain('sensitive-0');
    expect(more).toMatch(/\(\d+ of them sensitive\)/);
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
