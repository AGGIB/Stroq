import { describe, expect, it } from 'vitest';
import { inspectTree, InspectError } from '../../../src/install/inspect/index.js';
import { buildTree, treeDigest, TreeError } from '../../../src/install/tree.js';
import { PassportSchema, type SourceRef } from '../../../src/install/types.js';
import { stableStringify } from '@stroq/core';
import { CONTEXT, completeTree, passportOf } from '../../helpers/inspect.js';
import { entriesOf, fileEntry } from '../../helpers/install-tree.js';

describe('inspectTree: the passport around the lines', () => {
  it('names the digest, the number of files and their bytes', () => {
    const files = { 'SKILL.md': '# demo\n', 'a/b.txt': 'abc' };
    const tree = completeTree(files);

    const passport = passportOf(files);

    expect(passport.artifact.digest).toBe(treeDigest(tree));
    expect(passport.artifact.files).toBe(2);
    expect(passport.artifact.bytes).toBe(10);
    expect(passport.schema).toBe('stroq-passport/1');
  });

  it('counts regular files only, as the stats of a tree do', () => {
    const passport = passportOf({
      'SKILL.md': '# s\n',
      link: { symlink: 'SKILL.md' },
      sub: { gitlink: true },
    });

    expect(passport.artifact.files).toBe(1);
  });

  it('names the Stroq and the rules that made the reading', () => {
    const passport = passportOf(
      { 'SKILL.md': '# s\n' },
      { stroqVersion: '9.9.9', rulesId: 'rules/7' },
    );

    expect(passport.analysis).toEqual({ stroq: '9.9.9', rules: 'rules/7' });
  });

  it('carries the source as it was given', () => {
    const source: SourceRef = { type: 'npm', name: 'weather-mcp', version: '1.2.3' };

    expect(passportOf({ 'SKILL.md': '# s\n' }, { source }).artifact.source).toEqual(source);
  });

  it('has no findings of other tools, and no time, and no path of this machine', () => {
    const passport = passportOf({ 'SKILL.md': '# s\n' });
    const text = stableStringify(passport);

    expect(passport.imported).toEqual([]);
    expect(text).not.toMatch(/\/Users\/|\/home\/|\/tmp\/|[A-Z]:\\\\/);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('adds the blind spots of the reader to its own, sorted and without repeats', () => {
    const passport = passportOf(
      { 'SKILL.md': '# s\n' },
      { extraBlindSpots: ['a .git entry was left out', 'a .git entry was left out'] },
    );

    expect(passport.blindSpots).toContain('a .git entry was left out');
    expect(passport.blindSpots.filter((spot) => spot === 'a .git entry was left out')).toHaveLength(
      1,
    );
    expect(passport.blindSpots).toEqual([...passport.blindSpots].sort());
  });

  it('always lists what was not looked at, even for a tree with nothing in it that matters', () => {
    const passport = passportOf({ 'SKILL.md': '# s\n' });

    expect(passport.blindSpots.length).toBeGreaterThanOrEqual(3);
    expect(passport.lines).toEqual([]);
  });
});

describe('inspectTree: the name and version', () => {
  it('takes the name and version of a server from its package.json', () => {
    const passport = passportOf(
      { 'package.json': JSON.stringify({ name: 'weather-mcp', version: '2.0.1', main: 'i.js' }) },
      { kind: 'mcp' },
    );

    expect(passport.artifact.name).toBe('weather-mcp');
    expect(passport.artifact.version).toBe('2.0.1');
  });

  it('takes the name and version of a plugin from its manifest', () => {
    const passport = passportOf(
      { '.claude-plugin/plugin.json': JSON.stringify({ name: 'toolbox', version: '0.3.0' }) },
      { kind: 'plugin' },
    );

    expect(passport.artifact.name).toBe('toolbox');
    expect(passport.artifact.version).toBe('0.3.0');
  });

  it('takes the name and version of a Python server from its pyproject.toml', () => {
    const passport = passportOf(
      {
        'pyproject.toml':
          '[build-system]\nname = "not-this"\n\n[project]\nname = "py-server"\nversion = "0.9"\n\n[tool.x]\nname = "nor-this"\n',
      },
      { kind: 'mcp' },
    );

    expect(passport.artifact.name).toBe('py-server');
    expect(passport.artifact.version).toBe('0.9');
  });

  it.each<[string, SourceRef, string, string | null]>([
    ['a folder', { type: 'dir', label: 'my-skill' }, 'my-skill', null],
    ['a tarball', { type: 'tarball', label: 'pack.tgz' }, 'pack.tgz', null],
    ['a package', { type: 'npm', name: '@scope/pkg', version: '1.0.0' }, '@scope/pkg', '1.0.0'],
    [
      'a repository',
      { type: 'github', owner: 'o', repo: 'the-repo', ref: 'main' },
      'o/the-repo',
      null,
    ],
    ['an address', { type: 'url', host: 'files.example.com' }, 'files.example.com', null],
  ])(
    'is named for the source when the artifact says nothing, for %s',
    (_what, source, name, version) => {
      const passport = passportOf({ 'SKILL.md': '# s\n' }, { source });

      expect(passport.artifact.name).toBe(name);
      expect(passport.artifact.version).toBe(version);
    },
  );

  it('makes a name from the artifact safe to show, and cuts it', () => {
    const passport = passportOf(
      { 'package.json': JSON.stringify({ name: `evil\u202e${'x'.repeat(300)}`, main: 'i.js' }) },
      { kind: 'mcp' },
    );

    expect(passport.artifact.name).not.toContain('\u202e');
    expect(Array.from(passport.artifact.name).length).toBeLessThanOrEqual(100);
  });

  it('does not take a name that is not text', () => {
    const passport = passportOf(
      { 'package.json': JSON.stringify({ name: { a: 1 }, version: 3, main: 'i.js' }) },
      { kind: 'mcp', source: { type: 'dir', label: 'fallback' } },
    );

    expect(passport.artifact.name).toBe('fallback');
    expect(passport.artifact.version).toBeNull();
  });
});

describe('inspectTree: what it refuses', () => {
  it('refuses a tree of records without bytes, which has nothing to read', () => {
    const tree = buildTree([
      { path: 'SKILL.md', kind: 'file', exec: false, size: 3, sha256: 'ab'.repeat(32) },
    ]);

    expect(() => inspectTree(tree, CONTEXT)).toThrowError(
      expect.objectContaining({ name: 'InspectError', code: 'incomplete-tree' }),
    );
  });

  it('refuses a link without its target', () => {
    const entry = {
      path: 'l',
      kind: 'symlink' as const,
      exec: false,
      size: 1,
      sha256: 'ab'.repeat(32),
    };
    const tree = buildTree([entry]);

    expect(() => inspectTree(tree, CONTEXT)).toThrowError(InspectError);
  });

  it('refuses a tree whose bytes are no longer the ones it recorded', () => {
    const tree = buildTree(entriesOf({ 'SKILL.md': '# demo\n' }), { complete: true });
    (tree.entries[0]?.bytes as Uint8Array)[0] = 0x58;

    expect(() => inspectTree(tree, CONTEXT)).toThrowError(TreeError);
  });

  it('says what field is wrong when the source it was given is not a source', () => {
    const tree = buildTree([fileEntry('SKILL.md', '# s\n')], { complete: true });
    const source = { type: 'dir', label: '/abs/path' } as unknown as SourceRef;

    let caught: unknown;
    try {
      inspectTree(tree, { ...CONTEXT, source });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InspectError);
    expect((caught as InspectError).code).toBe('invalid-passport');
    expect((caught as InspectError).message).toContain('artifact.source');
  });

  it('gives a passport the strict schema accepts', () => {
    const passport = passportOf({ 'SKILL.md': '# s\n' });

    expect(PassportSchema.safeParse(passport).success).toBe(true);
  });
});
