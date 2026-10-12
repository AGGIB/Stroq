import { describe, expect, it } from 'vitest';
import type { SourceRef } from '../../../src/install/types.js';
import { lineOf, linesOf, passportOf, skillWith, subjectsOf } from '../../helpers/inspect.js';

/**
 * What an artifact calls itself is written by whoever wrote the artifact. A package fetched as
 * `npm:evil-pkg` that says `"name": "@modelcontextprotocol/server-github"` must not get a passport
 * with the trusted name for a title, so where the source names the artifact the title is the name of
 * the source, and what the artifact declares is shown as a declaration (the basis `declared`) and
 * never as the title. Nothing treats the declared name as verified.
 */
const npm = (name: string, version = '1.0.0'): SourceRef => ({ type: 'npm', name, version });
const github = (owner: string, repo: string): SourceRef => ({
  type: 'github',
  owner,
  repo,
  ref: 'main',
});

const LYING_PACKAGE = {
  'package.json': JSON.stringify({
    name: '@modelcontextprotocol/server-github',
    version: '99.0.0',
    main: 'index.js',
  }),
};

describe('a source that names the artifact: npm', () => {
  const passport = passportOf(LYING_PACKAGE, { kind: 'mcp', source: npm('evil-pkg', '1.0.0') });

  it('titles the passport with the name and the version of the source and not the declared ones', () => {
    expect(passport.artifact.name).toBe('evil-pkg');
    expect(passport.artifact.version).toBe('1.0.0');
    expect(JSON.stringify(passport.artifact)).not.toContain('server-github');
    expect(JSON.stringify(passport.artifact)).not.toContain('99.0.0');
  });

  it('adds a sensitive signal that the declared name differs, with the declared name as the subject only', () => {
    expect(passport.signals).toContainEqual({
      ruleId: 'declared-name-differs',
      file: 'package.json',
    });
    expect(
      lineOf(passport, 'signal', 'declared-name-differs: @modelcontextprotocol/server-github'),
    ).toMatchObject({
      sensitive: true,
      basis: 'declared',
      where: [{ file: 'package.json', line: null }],
    });
  });

  it('shows the declared name and version as a declaration of the artifact', () => {
    const line = lineOf(
      passport,
      'signal',
      'declared-name: @modelcontextprotocol/server-github 99.0.0',
    );

    expect(line).toMatchObject({ basis: 'declared', sensitive: false });
    expect(line?.detector).toContain('not been checked');
  });
});

describe('a source that names the artifact: GitHub', () => {
  it('titles the passport with owner and repository, whatever the manifest of a plugin says', () => {
    const passport = passportOf(
      {
        '.claude-plugin/plugin.json': JSON.stringify({
          name: 'official-anthropic-tools',
          version: '3.0.0',
        }),
      },
      { kind: 'plugin', source: github('evil', 'toolbox') },
    );

    expect(passport.artifact.name).toBe('evil/toolbox');
    expect(passport.artifact.version).toBeNull();
    expect(subjectsOf(passport, 'signal')).toContain(
      'declared-name-differs: official-anthropic-tools',
    );
    expect(subjectsOf(passport, 'signal')).toContain(
      'declared-name: official-anthropic-tools 3.0.0',
    );
  });

  it.each(['toolbox', 'Toolbox', 'evil/toolbox', '@evil/toolbox', '@Evil/Toolbox'])(
    'does not flag a declared name that is the repository: %s',
    (declared) => {
      const passport = passportOf(
        { '.claude-plugin/plugin.json': JSON.stringify({ name: declared }) },
        { kind: 'plugin', source: github('evil', 'toolbox') },
      );

      expect(passport.signals.map((signal) => signal.ruleId)).not.toContain(
        'declared-name-differs',
      );
      expect(passport.artifact.name).toBe('evil/toolbox');
    },
  );
});

describe('a skill that names another skill', () => {
  it('is titled with the source, and flagged', () => {
    const passport = passportOf(
      { 'SKILL.md': skillWith('name: anthropic-official-pdf\nversion: 9.9') },
      { kind: 'skill', source: npm('my-pdf-skill', '0.1.0') },
    );

    expect(passport.artifact.name).toBe('my-pdf-skill');
    expect(passport.artifact.version).toBe('0.1.0');
    expect(
      lineOf(passport, 'signal', 'declared-name-differs: anthropic-official-pdf')?.where,
    ).toEqual([{ file: 'SKILL.md', line: null }]);
  });
});

describe('a declared name that is the name of the source', () => {
  it('gives no signal, and still shows the declaration', () => {
    const passport = passportOf(
      {
        'package.json': JSON.stringify({
          name: '@acme/weather-mcp',
          version: '2.0.0',
          main: 'i.js',
        }),
      },
      { kind: 'mcp', source: npm('@acme/weather-mcp', '2.0.0') },
    );

    expect(passport.signals.map((signal) => signal.ruleId)).not.toContain('declared-name-differs');
    expect(subjectsOf(passport, 'signal')).toEqual(['declared-name: @acme/weather-mcp 2.0.0']);
    expect(passport.artifact.name).toBe('@acme/weather-mcp');
  });

  it('uses the version of the source even when the manifest says another', () => {
    const passport = passportOf(
      { 'package.json': JSON.stringify({ name: 'same', version: '7.7.7', main: 'i.js' }) },
      { kind: 'mcp', source: npm('same', '1.2.3') },
    );

    expect(passport.artifact.version).toBe('1.2.3');
  });
});

describe('a source that does not name the artifact: a folder, a tarball, an address', () => {
  const sources: [string, SourceRef][] = [
    ['a folder', { type: 'dir', label: 'some-folder' }],
    ['a tarball', { type: 'tarball', label: 'pack.tgz' }],
    ['an address', { type: 'url', host: 'files.example.com' }],
  ];

  it.each(sources)(
    'may be titled with the declared name, shown as declared, for %s',
    (_what, source) => {
      const passport = passportOf(
        {
          'package.json': JSON.stringify({
            name: 'declared-title',
            version: '4.0.0',
            main: 'i.js',
          }),
        },
        { kind: 'mcp', source },
      );

      expect(passport.artifact.name).toBe('declared-title');
      expect(passport.artifact.version).toBe('4.0.0');
      expect(lineOf(passport, 'signal', 'declared-name: declared-title 4.0.0')).toMatchObject({
        basis: 'declared',
        sensitive: false,
      });
      expect(passport.signals.map((signal) => signal.ruleId)).not.toContain(
        'declared-name-differs',
      );
    },
  );
});

describe('what the artifact declares, in every case', () => {
  it('says nothing when it declares no name and no version', () => {
    const passport = passportOf({ 'SKILL.md': '# s\n' }, { source: npm('plain', '1.0.0') });

    expect(passport.lines).toEqual([]);
    expect(passport.artifact.name).toBe('plain');
  });

  it('shows a version alone as a declaration', () => {
    const passport = passportOf(
      { 'package.json': JSON.stringify({ version: '5.0.0', main: 'i.js' }) },
      { kind: 'mcp', source: npm('named', '1.0.0') },
    );

    expect(subjectsOf(passport, 'signal')).toEqual(['declared-version: 5.0.0']);
    expect(passport.artifact.version).toBe('1.0.0');
  });

  it('does not take a name that is not text, or is empty, for a declaration', () => {
    for (const name of [5, '', '   ', null, ['x']]) {
      const passport = passportOf(
        { 'package.json': JSON.stringify({ name, main: 'i.js' }) },
        { kind: 'mcp', source: npm('named', '1.0.0') },
      );

      expect(linesOf(passport, 'signal')).toEqual([]);
      expect(passport.artifact.name).toBe('named');
    }
  });

  it('makes a declared name safe and bounded wherever it is shown', () => {
    const nasty = `evil\u202e${'x'.repeat(400)}\u001b[31m`;
    const passport = passportOf(
      { 'package.json': JSON.stringify({ name: nasty, version: `1\u200b.0`, main: 'i.js' }) },
      { kind: 'mcp', source: npm('named', '1.0.0') },
    );

    const subjects = linesOf(passport, 'signal').map((line) => line.subject);
    expect(subjects).toHaveLength(2);
    for (const subject of subjects) {
      expect(Array.from(subject).length).toBeLessThanOrEqual(200);
      expect(subject).not.toMatch(/[\u202e\u001b\u200b]/);
    }
    expect(passport.artifact.name).toBe('named');
  });

  it('puts the declaration where the artifact made it', () => {
    const passport = passportOf(
      { 'pyproject.toml': '[project]\nname = "py-thing"\nversion = "0.3"\n' },
      { kind: 'mcp', source: github('o', 'r') },
    );

    expect(lineOf(passport, 'signal', 'declared-name: py-thing 0.3')?.where).toEqual([
      { file: 'pyproject.toml', line: null },
    ]);
    expect(subjectsOf(passport, 'signal')).toContain('declared-name-differs: py-thing');
  });
});
