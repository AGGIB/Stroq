import { describe, expect, it } from 'vitest';
import { checkEntryPath, findCollisions } from '../../src/install/safe-path.js';

// There are two questions about a name that a disk answers by folding it: is it a name that opens
// something dangerous (`.git`, its short name, a device), and is it the same name as another in the
// tree. If the two rules fold differently, a spelling slips past one and is taken for the same name
// by the other. So both fold alike: the rule for fixed names is the collision rule's folding with one
// step in front of it (compatibility forms, NFKC), and these tests hold the two together.

const GIT = /\.git/;
const DEVICE = /Windows device name/;

const REFUSED: readonly (readonly [what: string, path: string, reason: RegExp])[] = [
  // The dotless i is "i" to the collision rule (upper case I, lower case i), and so it is here.
  ['.git with a dotless i', '.g\u0131t', GIT],
  ['.GIT with a dotless i, under a folder', 'a/.G\u0131T/config', GIT],
  ['the short name of .git with a dotless i', 'g\u0131t~1', GIT],
  ['the short name with a dotless i, in capitals', 'G\u0131T~12', GIT],
  ['CONIN$ with a dotless i', 'CON\u0131N$', DEVICE],
  // A dot that is not an ASCII dot still ends the name of a device once it is folded.
  ['a device name before a full-width dot', 'CON\uff0etxt', DEVICE],
  ['a device name before a one dot leader', 'nul\u2024txt', DEVICE],
  ['a device name before a small full stop', 'aux\ufe52log', DEVICE],
  // Full-width and superscript forms, which a narrower character set turns into the plain ones.
  ['a full-width device name', '\uff23\uff2f\uff2e', DEVICE],
  ['a full-width device name with an extension', '\uff2e\uff35\uff2c.log', DEVICE],
  ['a device name with a full-width digit', 'COM\uff11', DEVICE],
  ['a superscript digit', 'LPT\u00b2', DEVICE],
  ['.git written full-width', '\uff0e\uff47\uff49\uff54', GIT],
  [
    'the short name written full-width, with a full-width tilde',
    '\uff27\uff29\uff34\uff5e\uff11',
    GIT,
  ],
  // And still the plain ones, any case.
  ['.GIT', '.GIT', GIT],
  ['GIT~1', 'GIT~1', GIT],
  ['con', 'con', DEVICE],
  ['Nul.TXT', 'Nul.TXT', DEVICE],
  ['CONOUT$ in a folder', 'a/CONOUT$', DEVICE],
];

const ACCEPTED: readonly (readonly [what: string, path: string])[] = [
  // Only `git~N` is covered of the 8.3 short names (see the comment on GIT_SHORT_NAME): the file that
  // `.gitmodules` or `.gitattributes` is called by, on a disk that makes short names, is not looked for.
  ['the short name of .gitmodules', 'GITMOD~1'],
  ['the short name of .gitattributes', 'GITATT~1'],
  ['the short name of a long folder name', 'PROGRA~1/x'],
  ['.gitmodules itself', '.gitmodules'],
  ['.gitattributes itself', '.gitattributes'],
  // Names that begin like a reserved one are not it.
  ['git~ with nothing after', 'git~'],
  ['COM10', 'COM10'],
  ['a name that holds con', 'icon.png'],
  ['a dotted I is not an i', '.G\u0130T/x'],
  // A full-width z is a name of its own on every disk that matters; only fixed names are widened.
  ['a full-width letter in an ordinary name', '\uff5a.txt'],
];

describe('a name for a fixed name is folded as the collision rule folds', () => {
  it.each(REFUSED)('refuses %s', (_what, path, reason) => {
    expect(checkEntryPath(path)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(reason),
    });
  });

  it.each(ACCEPTED)('accepts %s', (_what, path) => {
    expect(checkEntryPath(path)).toEqual({ ok: true, path });
  });

  // The generated half. For each letter of the fixed names, the characters that the collision rule
  // takes for it are put in its place: the premise (that the collision rule does take them for it) is
  // checked first, so that the test cannot pass by trying nothing.
  describe('whatever the collision rule takes for a letter of a fixed name', () => {
    const SPELLINGS: Readonly<Record<string, readonly string[]>> = {
      g: ['G'],
      i: ['I', '\u0131'],
      t: ['T'],
      c: ['C'],
      o: ['O'],
      n: ['N'],
      p: ['P'],
      r: ['R'],
      a: ['A'],
      u: ['U'],
      x: ['X'],
      l: ['L'],
      m: ['M'],
    };
    const FIXED = [
      '.git',
      'git~1',
      'con',
      'prn',
      'aux',
      'nul',
      'com1',
      'lpt1',
      'conin$',
      'conout$',
    ];

    it('is taken for that letter by the collision rule, to begin with', () => {
      for (const [letter, others] of Object.entries(SPELLINGS)) {
        for (const other of others) {
          expect(
            findCollisions([`x${letter}x`, `x${other}x`]),
            `${letter} and ${other}`,
          ).toHaveLength(1);
        }
      }
    });

    it('is refused where it stands in a fixed name, at every place', () => {
      const missed: string[] = [];
      let tried = 0;

      for (const name of FIXED) {
        for (const [at, letter] of Array.from(name).entries()) {
          for (const other of SPELLINGS[letter] ?? []) {
            const spelled = `${name.slice(0, at)}${other}${name.slice(at + 1)}`;
            tried += 1;
            if (checkEntryPath(spelled).ok) missed.push(spelled);
          }
        }
      }

      expect(missed).toEqual([]);
      // Not a count to keep up with: only that the loops above tried a good many spellings.
      expect(tried).toBeGreaterThan(30);
    });
  });
});
