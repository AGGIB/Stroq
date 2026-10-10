import { describe, expect, it } from 'vitest';
import { PassportSchema, SourceRefSchema } from '../../src/install/types.js';

describe('SourceRefSchema', () => {
  it.each([
    ['a directory', { type: 'dir', label: 'my-skill' }],
    ['a relative directory', { type: 'dir', label: 'skills/demo' }],
    ['a tarball', { type: 'tarball', label: 'my-skill-1.0.tgz' }],
    ['an npm package', { type: 'npm', name: '@acme/server', version: '1.2.3' }],
    [
      'an npm package with its integrity',
      { type: 'npm', name: 'p', version: '1.0.0', integrity: 'sha512-AAAA' },
    ],
    ['a GitHub repository', { type: 'github', owner: 'acme', repo: 'demo', ref: 'main' }],
    [
      'a GitHub repository, fully pinned',
      {
        type: 'github',
        owner: 'acme',
        repo: 'demo',
        ref: 'v1',
        commit: '0123456789abcdef0123456789abcdef01234567',
        subdir: 'skills/demo',
      },
    ],
    ['a URL', { type: 'url', host: 'example.com' }],
  ])('accepts %s', (_what, value) => {
    expect(SourceRefSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['a type it does not know', { type: 'ftp', label: 'x' }],
    ['no type', { label: 'x' }],
    ['a directory with no label', { type: 'dir' }],
    ['a directory with an empty label', { type: 'dir', label: '' }],
    ['an npm package with no version', { type: 'npm', name: 'p' }],
    ['a GitHub repository with no ref', { type: 'github', owner: 'a', repo: 'b' }],
    ['a GitHub repository with an empty owner', { type: 'github', owner: '', repo: 'b', ref: 'c' }],
    ['a URL with no host', { type: 'url' }],
    ['a URL with a path as well', { type: 'url', host: 'example.com', path: '/x' }],
    [
      'an npm package with a key of a GitHub one',
      { type: 'npm', name: 'p', version: '1', ref: 'x' },
    ],
    [
      'an optional key given as undefined',
      { type: 'npm', name: 'p', version: '1', integrity: undefined },
    ],
  ])('rejects %s', (_what, value) => {
    expect(SourceRefSchema.safeParse(value).success).toBe(false);
  });

  // The passport is canonical so that an author can commit it, which a path on the author's own
  // disk would spoil: it differs from machine to machine and carries a user name.
  it.each([
    ['a Unix absolute path', '/home/me/skill'],
    ['a Windows drive path', 'C:\\Users\\me\\skill'],
    ['a Windows drive path with slashes', 'c:/Users/me/skill'],
    ['a UNC path', '\\\\server\\share\\skill'],
    ['a rooted Windows path', '\\Users\\me'],
  ])('does not take %s for a label', (_what, label) => {
    expect(SourceRefSchema.safeParse({ type: 'dir', label }).success).toBe(false);
    expect(SourceRefSchema.safeParse({ type: 'tarball', label }).success).toBe(false);
  });
});

// What a passport says of where an artifact came from is a label and not an address: it is read back
// from a lock file, printed, and compared, and it is never used to fetch anything. So a host is a bare
// host name and a label is a short relative name, and anything that would make either of them more
// than that is refused at the schema.
describe('the host of a URL source', () => {
  const parses = (host: unknown): boolean =>
    SourceRefSchema.safeParse({ type: 'url', host }).success;

  it.each([
    'example.com',
    'registry.npmjs.org',
    'codeload.github.com',
    'a.b.c.d.example',
    'xn--bcher-kva.example',
    'a-b.example',
    'a--b.example',
    '1password.com',
    'localhost',
    'x',
  ])('accepts %j', (host) => {
    expect(parses(host)).toBe(true);
  });

  it('accepts a name of 253 characters, and a label of 63', () => {
    expect(parses([63, 63, 63, 61].map((n) => 'a'.repeat(n)).join('.'))).toBe(true);
    expect(parses(`${'a'.repeat(63)}.example`)).toBe(true);
  });

  it.each([
    ['a scheme', 'https://example.com'],
    ['a scheme without slashes', 'https:example.com'],
    ['a path', 'example.com/path'],
    ['a trailing slash', 'example.com/'],
    ['a query', 'example.com?x=1'],
    ['a fragment', 'example.com#top'],
    ['user information', 'user@example.com'],
    ['user information with a password', 'user:secret@example.com'],
    ['a port', 'example.com:8080'],
    ['an IPv6 address', '[::1]'],
    ['a backslash', 'example.com\\x'],
    ['a wildcard', '*.example.com'],
    ['a space inside', 'exa mple.com'],
    ['a space around', ' example.com'],
    ['a line break', 'example.com\n'],
    ['an empty label', 'example..com'],
    ['a leading dot', '.example.com'],
    ['a trailing dot', 'example.com.'],
    ['a label that starts with a hyphen', '-a.example'],
    ['a label that ends with a hyphen', 'a-.example'],
    ['an underscore', 'a_b.example'],
    ['capital letters, which a host name in a passport does not have', 'Example.com'],
    ['a name that is not ASCII, which must be written in punycode', 'b\u00fccher.example'],
    ['a full-width dot', 'example\uff0ecom'],
    ['an IPv4 address', '192.0.2.1'],
    ['a last label that is a number', 'example.123'],
    ['a label of 64 characters', `${'a'.repeat(64)}.example`],
    ['a name of 254 characters', [63, 63, 63, 62].map((n) => 'a'.repeat(n)).join('.')],
    ['a name of 255 characters', [63, 63, 63, 63].map((n) => 'a'.repeat(n)).join('.')],
    ['nothing', ''],
    ['text that is not a host name at all', '!!!'],
  ])('rejects %s', (_what, host) => {
    expect(parses(host)).toBe(false);
  });

  it.each([
    ['a number', 5],
    ['null', null],
    ['undefined', undefined],
    ['a list', ['example.com']],
  ])('rejects %s, which is not text', (_what, host) => {
    expect(parses(host)).toBe(false);
  });

  it('refuses a host of a million characters without reading it through', () => {
    expect(parses('a'.repeat(1_000_000))).toBe(false);
    expect(parses('a.'.repeat(500_000))).toBe(false);
  });

  it('is refused inside a whole passport as well', () => {
    const passport = {
      schema: 'stroq-passport/1',
      artifact: {
        kind: 'skill',
        name: 'demo',
        version: null,
        source: { type: 'url', host: 'https://example.com/demo.tgz' },
        digest: '0'.repeat(64),
        files: 1,
        bytes: 1,
      },
      lines: [],
      blindSpots: [],
      signals: [],
      imported: [],
      analysis: { stroq: '0.23.0', rules: 'bundle-1' },
    };

    expect(PassportSchema.safeParse(passport).success).toBe(false);
    expect(
      PassportSchema.safeParse({
        ...passport,
        artifact: { ...passport.artifact, source: { type: 'url', host: 'example.com' } },
      }).success,
    ).toBe(true);
  });
});

describe('the label of a directory or tarball source', () => {
  describe.each(['dir', 'tarball'])('%s', (type) => {
    const parses = (label: unknown): boolean => SourceRefSchema.safeParse({ type, label }).success;

    it.each([
      'my-skill',
      'skills/demo',
      'my-skill-1.0.tgz',
      '.hidden',
      '..hidden',
      'a..b',
      'a/b..c',
      '...',
      'name with spaces',
      'caf\u00e9',
      'tilde~inside',
      'a'.repeat(80),
    ])('accepts %j', (label) => {
      expect(parses(label)).toBe(true);
    });

    it.each([
      ['a path from the root', '/home/me/skill'],
      ['a lone slash', '/'],
      ['a rooted Windows path', '\\Users\\me'],
      ['a UNC path', '\\\\server\\share'],
      ['the home directory', '~'],
      ['a path in the home directory', '~/skill'],
      ['a path in the home directory of somebody', '~user/skill'],
      ['a path in the home directory with a backslash', '~\\skill'],
      ['a drive and nothing else', 'C:'],
      ['a drive-relative path', 'C:skill'],
      ['a drive path in lower case', 'c:\\Users\\me'],
      ['a drive path with slashes', 'Z:/x'],
      ['the parent', '..'],
      ['a path that begins with the parent', '../skill'],
      ['a path with the parent in the middle', 'a/../b'],
      ['a path that ends with the parent', 'a/b/..'],
      ['the parent between backslashes', 'a\\..\\b'],
      ['the parent after a backslash', '..\\skill'],
      ['an empty label', ''],
      ['a label of 81 characters', 'a'.repeat(81)],
      ['a label of thousands of characters', 'a/'.repeat(5_000)],
    ])('rejects %s', (_what, label) => {
      expect(parses(label)).toBe(false);
    });

    it('rejects a label that is not text', () => {
      expect(parses(5)).toBe(false);
      expect(parses(undefined)).toBe(false);
    });
  });
});
