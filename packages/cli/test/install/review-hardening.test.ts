import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkEntryPath, quotePath } from '../../src/install/safe-path.js';
import { schemaFault } from '../../src/install/schema-fault.js';
import { SourceRefSchema } from '../../src/install/types.js';
import { buildTree, TreeError } from '../../src/install/tree.js';
import { fileEntry, symlinkEntry } from '../helpers/install-tree.js';

/**
 * What a review of the install contract found. The paths are written as escapes: the point of several
 * is that the character looks like another one, and a source file in which it looked like that would
 * hide it from whoever reads this.
 */
const u = (...codes: number[]): string => String.fromCodePoint(...codes);

describe('a name that a narrowing program turns into a separator', () => {
  const FULLWIDTH_DOT = u(0xff0e);
  const FULLWIDTH_SLASH = u(0xff0f);
  const FULLWIDTH_BACKSLASH = u(0xff3c);

  it.each([
    [
      'full-width dots and slashes that spell ../.git/hooks',
      `${FULLWIDTH_DOT}${FULLWIDTH_DOT}${FULLWIDTH_SLASH}${FULLWIDTH_DOT}git${FULLWIDTH_SLASH}hooks`,
    ],
    ['a full-width slash between two ordinary names', `a${FULLWIDTH_SLASH}b`],
    ['a full-width backslash', `a${FULLWIDTH_BACKSLASH}..${FULLWIDTH_BACKSLASH}x`],
  ])('is refused: %s', (_what, path) => {
    const checked = checkEntryPath(path);
    expect(checked.ok).toBe(false);
  });

  it('is refused with a phrase that does not repeat the name', () => {
    const checked = checkEntryPath(`a${FULLWIDTH_SLASH}b`);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).not.toContain(FULLWIDTH_SLASH);
  });

  it('leaves the full-width forms that CJK names use alone', () => {
    // A full-width colon or question mark is an ordinary letter of a Chinese file name.
    expect(checkEntryPath(`${u(0x7b2c)}1${u(0x7ae0)}${u(0xff1a)}${u(0x5f00, 0x59cb)}.md`).ok).toBe(
      true,
    );
    expect(checkEntryPath(`${u(0x4ec0, 0x4e48)}${u(0xff1f)}.md`).ok).toBe(true);
  });
});

describe('a combining mark that has a case of its own', () => {
  const YPOGEGRAMMENI = u(0x345);
  const IOTA = u(0x399);
  const GRAVE = u(0x300);

  it('is refused, since NTFS upper-cases it to a letter and two names become one', () => {
    expect(checkEntryPath(`a${YPOGEGRAMMENI}${GRAVE}.md`).ok).toBe(false);
    expect(checkEntryPath(`${YPOGEGRAMMENI}${GRAVE}`).ok).toBe(false);
  });

  it('is why these two cannot both come into a tree', () => {
    const one = `${IOTA}${GRAVE}.md`;
    const other = `${YPOGEGRAMMENI}${GRAVE}.md`;
    expect(checkEntryPath(one).ok).toBe(true);
    expect(checkEntryPath(other).ok).toBe(false);
  });
});

describe('a name that NTFS may give a second name', () => {
  it.each(['a-long-script~1.sh', 'PROGRA~1', 'x/GITMOD~1', 'x/y~12/z', 'name~9'])(
    'refuses %s, which looks like a short name',
    (path) => {
      expect(checkEntryPath(path).ok).toBe(false);
    },
  );

  it.each(['a~b.sh', 'notes~.md', 'a~', 'x~y/z', '~a'])('leaves %s alone', (path) => {
    expect(checkEntryPath(path).ok).toBe(true);
  });
});

describe('a name with a space that is not a space', () => {
  it.each([
    ['the braille blank', u(0x2800)],
    ['the ogham space mark', u(0x1680)],
    ['an en space', u(0x2002)],
    ['a no-break space', u(0xa0)],
    ['a narrow no-break space', u(0x202f)],
    ['a medium mathematical space', u(0x205f)],
    ['an ideographic space', u(0x3000)],
  ])('refuses %s in the middle of a name', (_what, character) => {
    expect(checkEntryPath(`a${character}b.md`).ok).toBe(false);
  });

  it('leaves the ordinary space alone', () => {
    expect(checkEntryPath('my notes.md').ok).toBe(true);
  });
});

describe('the target of a symlink', () => {
  it.each([
    ['a terminal escape', '\u001b]52;c;AAAA\u0007'],
    ['a replacement character', `a${u(0xfffd)}b`],
    ['a line break', 'x\ny'],
    ['a direction override', `${u(0x202e)}gnp.exe`],
  ])('may not hold %s', (_what, target) => {
    expect(() => buildTree([symlinkEntry('link', target)])).toThrow(TreeError);
  });

  it('may be an ordinary relative path', () => {
    expect(() => buildTree([symlinkEntry('link', '../shared/file.txt')])).not.toThrow();
  });
});

describe('an entry is judged by what it holds, not by what it says it holds', () => {
  it('refuses a file with no bytes when the tree has to be complete', () => {
    const { bytes: _bytes, ...claim } = fileEntry('SKILL.md', 'hello world');
    expect(() => buildTree([claim], { complete: true })).toThrow(/content/);
  });

  it('refuses a symlink with no target when the tree has to be complete', () => {
    const { target: _target, ...claim } = symlinkEntry('link', 'a');
    expect(() => buildTree([claim], { complete: true })).toThrow(/content/);
  });

  it('still takes a record without content when it is not asked to be complete', () => {
    const { bytes: _bytes, ...claim } = fileEntry('SKILL.md', 'hello world');
    expect(() => buildTree([claim])).not.toThrow();
  });

  it('does not believe the length a byte array reports about itself', () => {
    class Evil extends Uint8Array {
      override get byteLength(): number {
        return 1;
      }
    }
    const real = Evil.from(Buffer.from('xyz'));
    const entry = {
      path: 'SKILL.md',
      kind: 'file' as const,
      exec: false,
      size: 1,
      sha256: createHash('sha256').update('xyz').digest('hex'),
      bytes: real,
    };
    expect(() => buildTree([entry])).toThrow(TreeError);
  });
});

describe('the faults of a record are described without its own text', () => {
  const hostile = { type: 'dir', label: 'x', ['evil\u009b31m‮']: 1 };

  it('says what is wrong with a fixed phrase and the path of the fault', () => {
    const parsed = SourceRefSchema.safeParse(hostile);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const text = schemaFault(parsed.error);
    expect(text).not.toContain('\u009b');
    expect(text).not.toContain('‮');
    expect(text.length).toBeGreaterThan(0);
  });

  it('names the field that is wrong, quoted as a path is', () => {
    const parsed = SourceRefSchema.safeParse({ type: 'npm', name: '', version: '1' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(schemaFault(parsed.error)).toContain(quotePath('name'));
  });
});

describe('the parts of a source have a length', () => {
  it.each([
    ['an npm name', { type: 'npm', name: 'x'.repeat(5_000_000), version: '1' }],
    ['an npm version', { type: 'npm', name: 'x', version: '1'.repeat(1_000) }],
    ['a GitHub owner', { type: 'github', owner: 'o'.repeat(500), repo: 'r', ref: 'main' }],
    ['a GitHub repo', { type: 'github', owner: 'o', repo: 'r'.repeat(500), ref: 'main' }],
    ['a GitHub ref', { type: 'github', owner: 'o', repo: 'r', ref: 'm'.repeat(5_000) }],
  ])('refuses %s that is far too long', (_what, source) => {
    expect(SourceRefSchema.safeParse(source).success).toBe(false);
  });

  it('takes the longest names that npm and GitHub allow', () => {
    expect(
      SourceRefSchema.safeParse({ type: 'npm', name: 'x'.repeat(214), version: '1.0.0' }).success,
    ).toBe(true);
    expect(
      SourceRefSchema.safeParse({
        type: 'github',
        owner: 'o'.repeat(39),
        repo: 'r'.repeat(100),
        ref: 'refs/heads/main',
      }).success,
    ).toBe(true);
  });
});
