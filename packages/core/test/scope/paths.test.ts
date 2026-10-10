import fc from 'fast-check';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type PathOptions,
  type PathVerdict,
  defaultPathOptions,
  evaluatePath,
} from '../../src/scope/paths.js';
import type { PathRules } from '../../src/scope/types.js';
import { cpuNow } from '../cpu-time.js';
import { tempDir } from './helpers.js';

const POSIX: PathOptions = { flavor: 'posix', foldCase: false };
const POSIX_FOLD: PathOptions = { flavor: 'posix', foldCase: true };
const WIN: PathOptions = { flavor: 'win32', foldCase: true };
const WIN_EXACT: PathOptions = { flavor: 'win32', foldCase: false };

const rules = (allow: string[], deny: string[] = []): PathRules => ({ allow, deny });
const verdict = (
  r: PathRules,
  path: string,
  opts: PathOptions = POSIX,
  real?: string,
): PathVerdict => evaluatePath(r, real === undefined ? { path } : { path, real }, opts);

describe('glob semantics: * ? ** and literals', () => {
  it('matches a literal path exactly and nothing near it', () => {
    const r = rules(['/p/a.txt']);
    expect(verdict(r, '/p/a.txt')).toBe('allow');
    expect(verdict(r, '/p/b.txt')).toBe('outside');
    expect(verdict(r, '/p/a.txt/x')).toBe('outside');
    expect(verdict(r, '/q/p/a.txt')).toBe('outside');
  });

  it('lets * match any run of characters inside one segment, dot files included', () => {
    const r = rules(['/p/*.ts']);
    expect(verdict(r, '/p/a.ts')).toBe('allow');
    expect(verdict(r, '/p/.hidden.ts')).toBe('allow');
    expect(verdict(r, '/p/.ts')).toBe('allow');
    expect(verdict(r, '/p/sub/a.ts')).toBe('outside');
    expect(verdict(r, '/p/a.tsx')).toBe('outside');
  });

  it('lets ? match exactly one character and never a slash', () => {
    const r = rules(['/p/a?.ts']);
    expect(verdict(r, '/p/ab.ts')).toBe('allow');
    expect(verdict(r, '/p/a.ts')).toBe('outside');
    expect(verdict(r, '/p/abc.ts')).toBe('outside');
    expect(verdict(r, '/p/a/.ts')).toBe('outside');
  });

  it('counts a character outside the BMP as one character for ?', () => {
    expect(verdict(rules(['/p/a?']), '/p/a\u{1F600}')).toBe('allow');
  });

  it('lets ** match any number of whole segments, none included', () => {
    const r = rules(['/p/**/x.ts']);
    expect(verdict(r, '/p/x.ts')).toBe('allow');
    expect(verdict(r, '/p/a/x.ts')).toBe('allow');
    expect(verdict(r, '/p/a/b/c/x.ts')).toBe('allow');
    expect(verdict(r, '/p/a/y.ts')).toBe('outside');
    expect(verdict(r, '/q/a/x.ts')).toBe('outside');
  });

  it('treats a trailing /** as the directory and everything under it, but not a sibling that shares a prefix', () => {
    const r = rules(['/p/src/**']);
    expect(verdict(r, '/p/src')).toBe('allow');
    expect(verdict(r, '/p/src/a')).toBe('allow');
    expect(verdict(r, '/p/src/a/b/c.ts')).toBe('allow');
    expect(verdict(r, '/p/src2/a')).toBe('outside');
    expect(verdict(r, '/p/srcs')).toBe('outside');
    expect(verdict(r, '/p')).toBe('outside');
  });

  it('lets /** match every absolute path, and ** inside a segment act as *', () => {
    expect(verdict(rules(['/**']), '/anything/at/all')).toBe('allow');
    expect(verdict(rules(['/**']), '/')).toBe('allow');
    const r = rules(['/p/a**b']);
    expect(verdict(r, '/p/axxb')).toBe('allow');
    expect(verdict(r, '/p/ab')).toBe('allow');
    expect(verdict(r, '/p/a/b')).toBe('outside');
  });

  it('reads brackets, braces, bangs and backslashes as plain characters', () => {
    expect(verdict(rules(['/p/[ab].txt']), '/p/a.txt')).toBe('outside');
    expect(verdict(rules(['/p/[ab].txt']), '/p/[ab].txt')).toBe('allow');
    expect(verdict(rules(['/p/{a,b}']), '/p/a')).toBe('outside');
    expect(verdict(rules(['/p/{a,b}']), '/p/{a,b}')).toBe('allow');
    expect(verdict(rules(['/p/!x']), '/p/!x')).toBe('allow');
  });

  it('anchors a glob at the root: it never matches a path that merely contains it', () => {
    expect(verdict(rules(['/p/src/**']), '/home/p/src/a')).toBe('outside');
    expect(verdict(rules(['/p/*']), '/p/a/b')).toBe('outside');
  });

  it('does a * and ** pile-up in linear-ish time, not exponential', () => {
    const path = `/p/${'a'.repeat(3000)}`;
    const star = rules([`/p/${'*a'.repeat(25)}b`]);
    const started = cpuNow();
    expect(verdict(star, path)).toBe('outside');
    const deep = `/p/${'d/'.repeat(1500)}x`;
    expect(verdict(rules(['/p/**/**/**/**/**/**/y']), deep)).toBe('outside');
    expect(cpuNow() - started).toBeLessThan(4000);
  });
});

describe('path normalisation', () => {
  const r = rules(['/p/src/**'], ['/p/secret/**']);

  it('resolves .. so that a path cannot climb out of an allowed root', () => {
    expect(verdict(r, '/p/src/../secret/key')).toBe('deny');
    expect(verdict(r, '/p/src/../../etc/passwd')).toBe('outside');
    expect(verdict(r, '/p/src/a/../b')).toBe('allow');
  });

  it('clamps .. at the root, as a file system does', () => {
    expect(verdict(rules(['/etc/**']), '/../../etc/passwd')).toBe('allow');
  });

  it('collapses . segments and repeated slashes', () => {
    expect(verdict(r, '/p//src/./a')).toBe('allow');
    expect(verdict(r, '/p/./secret//k')).toBe('deny');
  });

  it('ignores a trailing slash on the path and on the glob', () => {
    expect(verdict(rules(['/p/src/']), '/p/src')).toBe('allow');
    expect(verdict(rules(['/p/src']), '/p/src/')).toBe('allow');
    expect(verdict(rules(['/p/src/**']), '/p/src/')).toBe('allow');
  });

  it('puts a path that is not absolute outside, however it is spelled', () => {
    for (const path of ['', 'src/a.ts', './src/a.ts', '../p/src/a', '~/x', 'C:\\p\\src\\a']) {
      expect(verdict(rules(['/**']), path)).toBe('outside');
    }
  });

  it('puts a path with a NUL, or one longer than any file system allows, outside', () => {
    expect(verdict(rules(['/**']), '/p/a\0b')).toBe('outside');
    expect(verdict(rules(['/**']), `/p/${'a'.repeat(5000)}`)).toBe('outside');
  });

  it('reads a backslash on POSIX as a character in a name, not as a separator', () => {
    expect(verdict(rules(['/p/a/b']), '/p/a\\b')).toBe('outside');
    expect(verdict(rules(['/p/a\\b']), '/p/a\\b')).toBe('allow');
  });
});

describe('deny wins', () => {
  const r = rules(['/p/**'], ['/p/**/.env*', '/p/.git/**']);

  it('refuses a path an allow glob covers when a deny glob covers it too', () => {
    expect(verdict(r, '/p/.env')).toBe('deny');
    expect(verdict(r, '/p/app/.env.local')).toBe('deny');
    expect(verdict(r, '/p/.git/config')).toBe('deny');
    expect(verdict(r, '/p/.git')).toBe('deny');
    expect(verdict(r, '/p/app/env')).toBe('allow');
  });

  it('says deny for a path in a deny glob even when no allow glob covers it', () => {
    expect(verdict(rules([], ['/x/**']), '/x/a')).toBe('deny');
    expect(verdict(rules([], []), '/x/a')).toBe('outside');
    expect(verdict(rules(['/p/**'], ['/x/**']), '/x/a')).toBe('deny');
  });

  it('reads a deny glob that cannot be read as denying everything, never as nothing', () => {
    expect(verdict(rules(['/p/**'], ['/p/../x/**']), '/p/a')).toBe('deny');
    expect(verdict(rules(['/p/**'], ['relative/**']), '/p/a')).toBe('deny');
  });

  it('reads an allow glob that cannot be read as allowing nothing', () => {
    expect(verdict(rules(['relative/**', '/p/../x']), '/p/a')).toBe('outside');
  });
});

describe('the lexical path and the real path must both pass', () => {
  const r = rules(['/p/**'], ['/p/secret/**']);

  it('allows a path whose real path is inside too, and a path with no real path', () => {
    expect(verdict(r, '/p/a', POSIX, '/p/b')).toBe('allow');
    expect(verdict(r, '/p/a')).toBe('allow');
  });

  it('puts a symlink inside the root that points out of it outside', () => {
    expect(verdict(r, '/p/link', POSIX, '/etc/passwd')).toBe('outside');
  });

  it('puts a path outside the root outside even when its real path is inside', () => {
    expect(verdict(r, '/tmp/link', POSIX, '/p/a')).toBe('outside');
  });

  it('denies a path whose real path is in a deny glob, and one whose lexical path is', () => {
    expect(verdict(r, '/p/link', POSIX, '/p/secret/k')).toBe('deny');
    expect(verdict(r, '/p/secret/k', POSIX, '/p/b')).toBe('deny');
  });

  it('puts a real path that is not absolute outside', () => {
    expect(verdict(r, '/p/a', POSIX, 'b')).toBe('outside');
  });

  it.skipIf(process.platform === 'win32')(
    'follows a real symlink out of an allowed root, as the resolver would report it',
    () => {
      const base = realpathSync(tempDir('paths'));
      const root = join(base, 'project');
      const outside = join(base, 'outside');
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(outside);
      writeFileSync(join(outside, 'secret.txt'), 'x');
      writeFileSync(join(root, 'src', 'ok.txt'), 'x');
      symlinkSync(outside, join(root, 'src', 'escape'));
      const scope = rules([`${root}/**`], [`${root}/.git/**`]);
      const viaLink = join(root, 'src', 'escape', 'secret.txt');
      expect(verdict(scope, viaLink)).toBe('allow');
      expect(verdict(scope, viaLink, POSIX, realpathSync(viaLink))).toBe('outside');
      const fine = join(root, 'src', 'ok.txt');
      expect(verdict(scope, fine, POSIX, realpathSync(fine))).toBe('allow');
    },
  );
});

describe('case folding is injected, not assumed', () => {
  it('compares case exactly when foldCase is off', () => {
    expect(verdict(rules(['/p/src/**']), '/P/SRC/a', POSIX)).toBe('outside');
    expect(verdict(rules([], ['/p/.env']), '/p/.ENV', POSIX)).toBe('outside');
  });

  it('folds case in the path and the glob when foldCase is on, deny included', () => {
    expect(verdict(rules(['/p/src/**']), '/P/SRC/a', POSIX_FOLD)).toBe('allow');
    expect(verdict(rules(['/P/Src/**']), '/p/src/a', POSIX_FOLD)).toBe('allow');
    expect(verdict(rules(['/p/**'], ['/p/**/.env*']), '/p/.ENV', POSIX_FOLD)).toBe('deny');
  });

  it('treats a composed and a decomposed accent as one name where case folds, as the file systems there do', () => {
    const composed = '/p/\u00e9.txt';
    const decomposed = '/p/e\u0301.txt';
    expect(verdict(rules([composed]), decomposed, POSIX_FOLD)).toBe('allow');
    expect(verdict(rules([composed]), decomposed, POSIX)).toBe('outside');
  });

  it('defaults foldCase to the platform and the flavour to the platform', () => {
    const defaults = defaultPathOptions();
    expect(defaults.flavor).toBe(process.platform === 'win32' ? 'win32' : 'posix');
    expect(defaults.foldCase).toBe(process.platform === 'darwin' || process.platform === 'win32');
  });
});

describe('the win32 flavour', () => {
  const r = rules(['C:/proj/**'], ['C:/proj/**/.env*', 'C:/proj/secret.txt']);

  it('reads backslashes as separators and drive letters as roots', () => {
    expect(verdict(r, 'C:\\proj\\src\\a.ts', WIN)).toBe('allow');
    expect(verdict(r, 'C:/proj/src/a.ts', WIN)).toBe('allow');
    expect(verdict(r, 'D:\\proj\\src\\a.ts', WIN)).toBe('outside');
    expect(verdict(r, 'C:\\other\\a.ts', WIN)).toBe('outside');
  });

  it('accepts a glob written with backslashes', () => {
    expect(verdict(rules(['C:\\proj\\**']), 'C:\\proj\\a', WIN)).toBe('allow');
  });

  it('folds the drive letter always, and the rest of the path only when told', () => {
    expect(verdict(r, 'c:\\PROJ\\Src\\A.ts', WIN)).toBe('allow');
    expect(verdict(r, 'c:\\proj\\src\\a.ts', WIN_EXACT)).toBe('allow');
    expect(verdict(r, 'c:\\PROJ\\src\\a.ts', WIN_EXACT)).toBe('outside');
  });

  it('denies a deny-listed name in any case when folding', () => {
    expect(verdict(r, 'C:\\PROJ\\.ENV', WIN)).toBe('deny');
    expect(verdict(r, 'C:\\proj\\SECRET.TXT', WIN)).toBe('deny');
  });

  it('resolves .. without leaving the drive', () => {
    expect(verdict(r, 'C:\\proj\\src\\..\\..\\..\\x', WIN)).toBe('outside');
    expect(verdict(r, 'C:\\proj\\src\\..\\.env', WIN)).toBe('deny');
  });

  it('reads \\\\?\\ and \\\\.\\ prefixes as the path they introduce', () => {
    expect(verdict(r, '\\\\?\\C:\\proj\\a', WIN)).toBe('allow');
    expect(verdict(r, '\\\\.\\C:\\proj\\.env', WIN)).toBe('deny');
    expect(verdict(rules(['//srv/share/**']), '\\\\?\\UNC\\srv\\share\\a', WIN)).toBe('allow');
  });

  it('understands UNC shares as roots', () => {
    const unc = rules(['//server/share/**']);
    expect(verdict(unc, '\\\\server\\share\\a\\b', WIN)).toBe('allow');
    expect(verdict(unc, '\\\\server\\other\\a', WIN)).toBe('outside');
    expect(verdict(unc, '\\\\SERVER\\SHARE\\a', WIN)).toBe('allow');
  });

  it('sees through trailing dots and spaces, which Windows drops from a name', () => {
    expect(verdict(r, 'C:\\proj\\secret.txt.', WIN)).toBe('deny');
    expect(verdict(r, 'C:\\proj\\secret.txt ', WIN)).toBe('deny');
    expect(verdict(r, 'C:\\proj\\.env. .', WIN)).toBe('deny');
    expect(verdict(r, 'C:\\proj\\src. \\a', WIN)).toBe('allow');
  });

  it('sees through an alternate data stream: writing a stream writes the file', () => {
    expect(verdict(r, 'C:\\proj\\secret.txt:hidden', WIN)).toBe('deny');
    expect(verdict(r, 'C:\\proj\\secret.txt::$DATA', WIN)).toBe('deny');
  });

  it('puts a rooted path with no drive, a drive-relative path and a POSIX path outside', () => {
    expect(verdict(rules(['C:/**']), '\\proj\\a', WIN)).toBe('outside');
    expect(verdict(rules(['C:/**']), 'C:proj\\a', WIN)).toBe('outside');
    expect(verdict(rules(['C:/**']), '/proj/a', WIN)).toBe('outside');
  });

  it('applies the same rule to the real path', () => {
    expect(verdict(r, 'C:\\proj\\link', WIN, 'D:\\elsewhere\\x')).toBe('outside');
    expect(verdict(r, 'C:\\proj\\link', WIN, 'C:\\proj\\.env')).toBe('deny');
  });
});

describe('evaluatePath never throws, whatever it is given', () => {
  it('returns one of the three verdicts for arbitrary strings, in both flavours', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        fc.array(fc.string({ maxLength: 60 }), { maxLength: 4 }),
        fc.array(fc.string({ maxLength: 60 }), { maxLength: 4 }),
        fc.boolean(),
        fc.boolean(),
        (path, allow, deny, foldCase, win) => {
          const opts: PathOptions = { flavor: win ? 'win32' : 'posix', foldCase };
          const result = evaluatePath({ allow, deny }, { path, real: path }, opts);
          expect(['allow', 'deny', 'outside']).toContain(result);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('denies a path that a deny glob spells out exactly, whatever else is allowed', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z0-9_-][a-z0-9._-]{0,7}$/), { minLength: 1, maxLength: 5 }),
        (segments) => {
          const path = `/${segments.join('/')}`;
          expect(evaluatePath(rules(['/**'], [path]), { path }, POSIX)).toBe('deny');
        },
      ),
      { numRuns: 200 },
    );
  });
});
