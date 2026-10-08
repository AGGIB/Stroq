import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  VERBATIM_LIMIT,
  anchorOf,
  condense,
  findSection,
  leadOf,
  releaseNotes,
} from '../../../../scripts/release-notes.js';

const ROOT = new URL('../../../../', import.meta.url);
const CHANGELOG = readFileSync(new URL('CHANGELOG.md', ROOT), 'utf8');

const SMALL = `# Changelog

## [Unreleased]

### Added

- **Not out yet.** Nothing here is a release.

## [1.2.0] - 2026-01-02

### Added

- **A thing.** It does what it says.
- A plain change without a bold lead. It goes on for a while.

### Fixed

- **A bug.** It is gone.

## [1.1.0] - 2026-01-01

### Added

- **An older thing.** Long ago.
`;

describe('findSection', () => {
  it('returns what stands under the heading of the version, up to the next version', () => {
    const section = findSection(SMALL, '1.2.0');

    expect(section?.heading).toBe('[1.2.0] - 2026-01-02');
    expect(section?.body).toContain('**A thing.**');
    expect(section?.body).toContain('**A bug.**');
    expect(section?.body).not.toContain('An older thing');
    expect(section?.body).not.toContain('Not out yet');
  });

  it('returns the last section to the end of the file', () => {
    expect(findSection(SMALL, '1.1.0')?.body).toContain('An older thing');
  });

  it('is null for a version that has no section, and for the unreleased one', () => {
    expect(findSection(SMALL, '9.9.9')).toBeNull();
    expect(findSection(SMALL, 'Unreleased')?.body).toContain('Not out yet');
  });

  it('does not take a release candidate for the release', () => {
    const text = '## [1.2.0-rc.1] - 2026-01-01\n\n- **rc.**\n';

    expect(findSection(text, '1.2.0')).toBeNull();
    expect(findSection(text, '1.2.0-rc.1')?.body).toBe('- **rc.**');
  });
});

describe('anchorOf', () => {
  it.each([
    ['[0.23.0] - 2026-10-08', '0230---2026-10-08'],
    ['[0.22.0] - 2026-10-01', '0220---2026-10-01'],
    ['[1.0.0-rc.1] - 2026-01-01', '100-rc1---2026-01-01'],
  ])('gives %s the anchor GitHub gives it', (heading, anchor) => {
    expect(anchorOf(heading)).toBe(anchor);
  });
});

describe('leadOf', () => {
  it('is the bold opening of a change', () => {
    expect(leadOf('- **`stroq init` asks first.** It lists the agents.')).toBe(
      '`stroq init` asks first.',
    );
  });

  it('is the first sentence of a change that has no bold opening', () => {
    expect(leadOf('- A plain change. It goes on.')).toBe('A plain change.');
  });

  it('is cut where a change has no sentence end', () => {
    expect(leadOf(`- ${'x'.repeat(500)}`)).toHaveLength(200);
  });
});

describe('condense', () => {
  it('keeps the headings and gives each change one line', () => {
    const body = findSection(SMALL, '1.2.0')?.body ?? '';

    expect(condense(body)).toBe(
      [
        '### Added',
        '',
        '- A thing.',
        '- A plain change without a bold lead.',
        '',
        '### Fixed',
        '',
        '- A bug.',
      ].join('\n'),
    );
  });

  it('cuts a paragraph that is not a list at the end of a sentence', () => {
    const sentence = 'It was measured on a real machine. ';
    const out = condense(`### Measured\n\n${sentence.repeat(100)}`);

    expect(out.length).toBeLessThan(1_600);
    expect(out.endsWith('machine.')).toBe(true);
  });

  it('leaves no run of blank lines', () => {
    expect(condense('### A\n\n\n\n- **x.** y\n\n\n### B\n\n- **z.**')).not.toMatch(/\n{3,}/);
  });
});

describe('releaseNotes', () => {
  it('is the install line, a link to the section and the section as it is, where it is short', () => {
    const notes = releaseNotes(SMALL, '1.2.0');

    expect(notes.startsWith('Install: `npm i -g @stroq/cli@1.2.0`')).toBe(true);
    expect(notes).toContain(
      '(https://github.com/AGGIB/Stroq/blob/main/CHANGELOG.md#120---2026-01-02)',
    );
    expect(notes).toContain('- **A thing.** It does what it says.');
    expect(notes.endsWith('\n')).toBe(true);
  });

  it('is condensed where the section is longer than a page can be', () => {
    const bullets = Array.from(
      { length: 40 },
      (_, i) => `- **Change ${i}.** ${'It is explained at length. '.repeat(40)}`,
    );
    const text = `## [2.0.0] - 2026-02-01\n\n### Added\n\n${bullets.join('\n')}\n`;
    const section = findSection(text, '2.0.0');
    expect(section?.body.length).toBeGreaterThan(VERBATIM_LIMIT);

    const notes = releaseNotes(text, '2.0.0');

    expect(notes.length).toBeLessThan(3_000);
    expect(notes).toContain('- Change 0.');
    expect(notes).toContain('- Change 39.');
    expect(notes).not.toContain('explained at length');
  });

  it('refuses a version that has no section, and one whose section is empty', () => {
    expect(() => releaseNotes(SMALL, '9.9.9')).toThrow(/no section for 9\.9\.9/);
    expect(() =>
      releaseNotes('## [3.0.0] - 2026-03-01\n\n## [2.0.0] - 2026-02-01\n', '3.0.0'),
    ).toThrow(/empty/);
  });

  it('names another repository where it is asked to', () => {
    expect(releaseNotes(SMALL, '1.2.0', 'someone/else')).toContain(
      'https://github.com/someone/else/blob/main/CHANGELOG.md#',
    );
  });
});

describe('the changelog of this repository', () => {
  const version = (
    JSON.parse(readFileSync(new URL('packages/cli/package.json', ROOT), 'utf8')) as {
      version: string;
    }
  ).version;

  it('has a section for the version of the package, which a release page is made from', () => {
    const section = findSection(CHANGELOG, version);

    expect(section, `CHANGELOG.md needs a "## [${version}]" section`).not.toBeNull();
    expect(section?.body.length ?? 0).toBeGreaterThan(0);
  });

  it('makes release notes of that section that GitHub accepts (up to 125,000 characters)', () => {
    const notes = releaseNotes(CHANGELOG, version);

    expect(notes.length).toBeGreaterThan(100);
    expect(notes.length).toBeLessThan(125_000);
  });

  it.each(['0.22.0', '0.21.2', '0.21.0'])('makes notes of the section of %s too', (old) => {
    expect(releaseNotes(CHANGELOG, old).length).toBeLessThan(125_000);
  });
});
