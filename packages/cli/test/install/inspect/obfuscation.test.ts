import { describe, expect, it } from 'vitest';
import {
  BASE64_RUN,
  ESCAPE_RUN,
  HEX_NAMES,
  LONG_LINE,
  obfuscationReasons,
} from '../../../src/install/inspect/obfuscation.js';
import { cpuNow } from '../../helpers/cpu-time.js';
import { lineOf, passportOf } from '../../helpers/inspect.js';

const ordinary = `
import { readFile } from 'node:fs/promises';

export async function load(path) {
  const text = await readFile(path, 'utf8');
  return text.split('\\n').map((line) => line.trim()).filter(Boolean);
}
`.repeat(10);

describe('obfuscationReasons', () => {
  it('says nothing of ordinary code', () => {
    expect(obfuscationReasons(ordinary)).toEqual([]);
  });

  it('says nothing of an empty file or a short one', () => {
    expect(obfuscationReasons('')).toEqual([]);
    expect(obfuscationReasons('{};;;;()()()')).toEqual([]);
  });

  it('names a line of thousands of characters', () => {
    expect(obfuscationReasons(`a = 1;${'x = 1; '.repeat(LONG_LINE / 7 + 10)}\n`)).toContain(
      'a line of thousands of characters',
    );
  });

  it('does not name a line at the limit', () => {
    expect(obfuscationReasons(`${'a'.repeat(LONG_LINE)}\n`)).not.toContain(
      'a line of thousands of characters',
    );
  });

  it('names text made mostly of punctuation', () => {
    const table = '{[(<>)]};:,.!?'.repeat(100);

    expect(obfuscationReasons(`${table}\n`)).toContain('mostly punctuation');
  });

  it('names a long run of escapes, in either form', () => {
    expect(obfuscationReasons(`var s = "${'\\x41'.repeat(ESCAPE_RUN)}";`)).toContain(
      'a long run of escape sequences',
    );
    expect(obfuscationReasons(`var s = "${'\\u0041'.repeat(ESCAPE_RUN)}";`)).toContain(
      'a long run of escape sequences',
    );
  });

  it('does not name a short run of escapes, or one broken by a letter', () => {
    expect(obfuscationReasons(`var s = "${'\\x41'.repeat(ESCAPE_RUN - 1)}";`)).toEqual([]);
    expect(obfuscationReasons(`${('\\x41' + 'z').repeat(ESCAPE_RUN * 2)}`)).toEqual([]);
  });

  it('does not take a backslash with no hexadecimal digits for an escape', () => {
    expect(obfuscationReasons(`"${'\\xZZ'.repeat(100)}"`)).not.toContain(
      'a long run of escape sequences',
    );
  });

  it('names a long run of base64', () => {
    expect(
      obfuscationReasons(`const blob = "${'QUJDREVG'.repeat(BASE64_RUN / 8 + 1)}";`),
    ).toContain('a long run of base64');
  });

  it('names a run of base64 of more than 200 characters, and not one of 200', () => {
    const blob = (length: number) => `const blob = "${'Q'.repeat(length)}";`;

    expect(obfuscationReasons(blob(BASE64_RUN))).toEqual([]);
    expect(obfuscationReasons(blob(BASE64_RUN + 1))).toContain('a long run of base64');
  });

  it('names the identifiers one obfuscator makes', () => {
    const code = Array.from(
      { length: HEX_NAMES },
      (_, i) => `var _0x${(0x1a2b + i).toString(16)} = ${i};`,
    ).join('\n');

    expect(obfuscationReasons(code)).toContain('identifiers like _0x1a2b');
    expect(
      obfuscationReasons(
        code
          .split('\n')
          .slice(0, HEX_NAMES - 1)
          .join('\n'),
      ),
    ).toEqual([]);
  });

  it('does not count _0x inside a longer name', () => {
    expect(obfuscationReasons('var a_0x1a2b = 1;\n'.repeat(HEX_NAMES * 2))).toEqual([]);
  });

  it('lists the signs it finds in a fixed order', () => {
    const text = `${'\\x41'.repeat(ESCAPE_RUN)}${'Q'.repeat(BASE64_RUN)}${'z'.repeat(LONG_LINE)}`;

    const reasons = obfuscationReasons(text);

    expect(reasons).toEqual([...reasons].sort());
    expect(reasons.length).toBeGreaterThanOrEqual(3);
  });

  it('reads a megabyte of every shape in a time that follows its size', () => {
    const shapes = [
      'a',
      '\\x41',
      '_0x1a2b',
      'Qk',
      '(',
      '\n',
      ' ',
      '\\',
      '\\x',
      '\\u00',
      '_0x',
      '\\\\x41',
    ];
    for (const shape of shapes) {
      const text = shape.repeat(Math.ceil((1024 * 1024) / shape.length));
      const started = cpuNow();

      obfuscationReasons(text);

      expect(cpuNow() - started, `shape ${JSON.stringify(shape)}`).toBeLessThan(1000);
    }
  });
});

describe('obfuscation in a passport', () => {
  const minified = `${'function a(b){return b+1}'.repeat(400)}\n`;

  it('makes a sensitive signal of a file that looks minified, and says it was not understood', () => {
    const passport = passportOf({ 'dist/server.js': minified }, { kind: 'mcp' });

    expect(passport.signals).toContainEqual({ ruleId: 'obfuscated', file: 'dist/server.js' });
    const line = passport.lines.find((candidate) => candidate.subject.startsWith('obfuscated'));
    expect(line).toMatchObject({ kind: 'signal', sensitive: true, basis: 'observed' });
    expect(line?.subject).toContain('a line of thousands of characters');
    expect(line?.detector).toContain('not a verdict');
    expect(
      passport.blindSpots.some((spot) => spot.startsWith('1 file looks minified or obfuscated')),
    ).toBe(true);
  });

  it('still reads a minified file for what it reaches for', () => {
    const passport = passportOf(
      {
        'dist/server.js': `${minified}fetch("https://api.hidden.example/x");process.env.SECRET_KEY;\n`,
      },
      { kind: 'mcp' },
    );

    expect(lineOf(passport, 'net', 'api.hidden.example')).toBeDefined();
    expect(lineOf(passport, 'cred.env', 'SECRET_KEY')).toBeDefined();
  });

  it('reads Python and shell files too, and not text that is not code', () => {
    const passport = passportOf({
      'a.py': minified,
      'b.sh': minified,
      'c.ps1': minified,
      'notes.txt': minified,
      'data.json': minified,
    });

    expect(passport.signals.map((signal) => signal.file).sort()).toEqual(['a.py', 'b.sh', 'c.ps1']);
  });

  it('says nothing of ordinary code', () => {
    const passport = passportOf({ 'lib/a.js': ordinary });

    expect(passport.signals).toEqual([]);
  });
});
