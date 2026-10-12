import { describe, expect, it } from 'vitest';
import { renderPassport } from '../../src/commands/vet-render.js';
import { DIGEST, BLIND, many, passportWith } from '../helpers/vet-passport.js';

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
