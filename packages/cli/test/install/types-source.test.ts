import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkEntryPath } from '../../src/install/safe-path.js';
import { PassportSchema, SourceRefSchema } from '../../src/install/types.js';

const hex = (code: number): string => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
const REAL_INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const REAL_COMMIT = '0123456789abcdef0123456789abcdef01234567';

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
    // Not numbers to a URL parser: a name that only looks like one.
    'example.0xyz',
    'example.0xg',
    'example.0b1',
    '0x1.example',
    'x0x1.example',
    'a.b0x1',
    'a.1a',
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
    // The URL standard reads a last label of `0x` and hex digits as a number too, and so the whole host
    // as an IPv4 address: `http://0x7f000001/` is 127.0.0.1.
    ['a hexadecimal number', '0x7f000001'],
    ['the address of the metadata service in hexadecimal', '0xa9fea9fe'],
    ['dotted hexadecimal numbers', '0x7f.0x1'],
    ['an address with two hexadecimal parts', '0x7f.0.0.0x1'],
    ['an address with all hexadecimal parts', '0x7f.0x0.0x0.0x1'],
    ['an address with one hexadecimal part', '1.1.1.0x1'],
    ['a hexadecimal prefix and no digits', 'example.0x'],
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

  // The reason for the rules above, asked of the parser that matters: a host that is accepted is a name
  // to a URL parser and comes back as the same text, and never as an address it has turned into.
  it('only accepts hosts that a URL parser keeps as they are', () => {
    const label = fc.constantFrom(
      ...['0', '1', '7', '07', '0x', '0x1', '0x7f', '0xf', '0xg', '0xyz', 'x', 'x0x1', 'a', 'ff'],
      ...['1a', '0b1', '9', '0377', 'example', 'com'],
    );
    const host = fc.array(label, { minLength: 1, maxLength: 4 }).map((parts) => parts.join('.'));
    let accepted = 0;
    let refused = 0;

    fc.assert(
      fc.property(host, (text) => {
        if (!parses(text)) {
          refused += 1;
          return;
        }
        accepted += 1;
        expect(new URL(`http://${text}/`).hostname, text).toBe(text);
      }),
      { numRuns: 3_000 },
    );

    expect(accepted).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(100);
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

// An npm or a GitHub reference names exactly what it came from (a name, a version and an integrity; an
// owner, a repo, a ref and a commit), so each part is held to what it is: the passport is canonical and
// is read back from files that somebody else may have written, so nothing in it is a path of a machine,
// and nothing in it is text that a terminal or a README would do something with.
describe('the exact parts of an npm or a GitHub source', () => {
  const npm = (extra: Record<string, unknown>): unknown => ({
    type: 'npm',
    name: 'p',
    version: '1.0.0',
    ...extra,
  });
  const github = (extra: Record<string, unknown>): unknown => ({
    type: 'github',
    owner: 'acme',
    repo: 'demo',
    ref: 'main',
    ...extra,
  });
  const parses = (value: unknown): boolean => SourceRefSchema.safeParse(value).success;

  it.each([
    ['a sha-512 integrity', npm({ integrity: REAL_INTEGRITY })],
    ['a short sha-512 integrity, as a fixture may write one', npm({ integrity: 'sha512-AAAA' })],
    ['an integrity with one pad character', npm({ integrity: 'sha512-AAAAAAA=' })],
    ['a full commit', github({ commit: REAL_COMMIT })],
    ['a subdirectory', github({ subdir: 'skills/demo' })],
    ['a subdirectory with a dot in the name', github({ subdir: '.claude/skills' })],
    ['a subdirectory with a name that is not Latin', github({ subdir: 'caf\u00e9/\u65e5\u672c' })],
  ])('accepts %s', (_what, value) => {
    expect(parses(value)).toBe(true);
  });

  it.each([
    ['an integrity that is not an integrity', npm({ integrity: 'x' })],
    ['an integrity that is a sha-1', npm({ integrity: 'sha1-AAAA' })],
    ['an integrity of nothing', npm({ integrity: 'sha512-' })],
    ['an integrity with a character that is not base64', npm({ integrity: 'sha512-AA!A' })],
    ['an integrity with three pad characters', npm({ integrity: 'sha512-AAAA===' })],
    ['two integrities', npm({ integrity: 'sha512-AAAA sha512-BBBB' })],
    ['a commit that is not hexadecimal', github({ commit: 'zzz' })],
    ['a short commit', github({ commit: '0123456' })],
    ['a commit in capitals', github({ commit: REAL_COMMIT.toUpperCase() })],
    ['a commit of 41 digits', github({ commit: `${REAL_COMMIT}0` })],
    ['a commit with a path after it', github({ commit: `${REAL_COMMIT}/x` })],
    ['a subdirectory from the root of a disk', github({ subdir: '/home/me/skills' })],
    ['a subdirectory in the home directory', github({ subdir: '~/skills' })],
    ['a subdirectory on a drive', github({ subdir: 'C:\\Users\\me' })],
    ['a subdirectory that climbs out', github({ subdir: '../skills' })],
    ['a subdirectory that climbs out in the middle', github({ subdir: 'a/../../b' })],
    ['a subdirectory that climbs out with backslashes', github({ subdir: 'a\\..\\b' })],
    ['an empty subdirectory', github({ subdir: '' })],
  ])('rejects %s', (_what, value) => {
    expect(parses(value)).toBe(false);
  });

  const TEXT_FIELDS: readonly (readonly [where: string, make: (text: string) => unknown])[] = [
    ['the label of a directory', (text) => ({ type: 'dir', label: text })],
    ['the label of a tarball', (text) => ({ type: 'tarball', label: text })],
    ['the name of an npm package', (text) => npm({ name: text })],
    ['the version of an npm package', (text) => npm({ version: text })],
    ['the owner of a repository', (text) => github({ owner: text })],
    ['the name of a repository', (text) => github({ repo: text })],
    ['the ref of a repository', (text) => github({ ref: text })],
    ['the subdirectory of a repository', (text) => github({ subdir: text })],
  ];

  const UNSHOWABLE: readonly (readonly [what: string, text: string])[] = [
    ['an escape sequence', 'x\u001b[2Jy'],
    ['a newline', 'a\nb'],
    ['a NUL', 'a\u0000b'],
    ['a C1 control', 'a\u009bb'],
    ['a direction override', 'a\u202eb'],
    ['a direction isolate', 'a\u2066b'],
    ['a zero-width space', 'a\u200bb'],
    ['a line separator', 'a\u2028b'],
    ['a soft hyphen', 'a\u00adb'],
    ['a tag character', 'a\u{e0041}b'],
    ['a lone surrogate', 'a\ud800b'],
  ];

  describe.each(TEXT_FIELDS)('%s', (_where, make) => {
    it.each(['plain-text', 'caf\u00e9', '\u65e5\u672c\u8a9e', 'a b', '@acme/server'])(
      'takes %j',
      (text) => {
        expect(parses(make(text))).toBe(true);
      },
    );

    it.each(UNSHOWABLE)('refuses %s', (_what, text) => {
      expect(parses(make(text))).toBe(false);
    });
  });

  // The parts are checked by patterns, and a passport is read back from a file that somebody else may
  // have written, so none of them may take longer than the text is long.
  it('refuses a part of a million characters without reading it through again and again', () => {
    const million = 1_000_000;

    expect(parses(npm({ integrity: `sha512-${'A'.repeat(million)}!` }))).toBe(false);
    expect(parses(npm({ integrity: `sha512-${'A'.repeat(million)}===` }))).toBe(false);
    expect(parses(github({ commit: 'a'.repeat(million) }))).toBe(false);
    expect(parses(github({ subdir: 'a/'.repeat(million / 2) }))).toBe(false);
    expect(parses({ type: 'dir', label: 'a/.'.repeat(million / 3) })).toBe(false);
    expect(parses({ type: 'tarball', label: `${'a'.repeat(million)}\u0000` })).toBe(false);
  });

  // What is refused as unshowable is what a path refuses as unshowable, by the same Unicode properties,
  // and nothing else: asked of every code point, so that a class that one of them narrows is seen.
  it('refuses the controls and the invisible characters that a path refuses, and no other', () => {
    const wrong: string[] = [];
    let unshowable = 0;

    for (let code = 0; code <= 0x10ffff; code += 1) {
      const char = String.fromCodePoint(code);
      // Two letters before the character, so that a colon is not read as the end of a drive letter.
      const verdict = checkEntryPath(`ab${char}b`);
      const refusedAsText =
        !verdict.ok &&
        /control character|invisible or direction-changing|valid Unicode/.test(verdict.reason);
      if (refusedAsText) unshowable += 1;
      if (parses({ type: 'dir', label: `ab${char}b` }) === refusedAsText) wrong.push(hex(code));
    }

    expect(wrong).toEqual([]);
    expect(unshowable).toBeGreaterThan(4_000);
  });
});
