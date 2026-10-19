import { describe, expect, it } from 'vitest';
import { lineOf, parseJsonc, stripJsonc } from '../../src/exposure/jsonc.js';

describe('parseJsonc', () => {
  it('reads plain JSON', () => {
    expect(parseJsonc('{"a": [1, "b"]}')).toEqual({ a: [1, 'b'] });
  });

  // VS Code reads tasks.json, settings.json and devcontainer.json with comments and trailing
  // commas. A strict parser hid the whole file behind one `//` line.
  it('reads line comments, block comments and trailing commas', () => {
    const text = [
      '// tasks for this folder',
      '{',
      '  /* the one that matters */',
      '  "tasks": [',
      '    { "label": "x", "command": "node a.mjs", }, // trailing',
      '  ],',
      '}',
    ].join('\n');
    expect(parseJsonc(text)).toEqual({ tasks: [{ label: 'x', command: 'node a.mjs' }] });
  });

  it('leaves comment markers and commas inside strings alone', () => {
    expect(parseJsonc('{"u": "https://example.invalid/a,]", "c": "/* not */"}')).toEqual({
      u: 'https://example.invalid/a,]',
      c: '/* not */',
    });
  });

  it('reads a string with an escaped quote and a backslash before the end', () => {
    expect(parseJsonc('{"a": "say \\"hi\\" // still a string", "b": "c:\\\\"}')).toEqual({
      a: 'say "hi" // still a string',
      b: 'c:\\',
    });
  });

  it('skips a byte order mark', () => {
    expect(parseJsonc('\ufeff{"a": 1}')).toEqual({ a: 1 });
  });

  it('answers undefined for text that is not JSON, never throwing', () => {
    expect(parseJsonc('{"a": ')).toBeUndefined();
    expect(parseJsonc('not json')).toBeUndefined();
    expect(parseJsonc('/* never closed')).toBeUndefined();
    expect(parseJsonc('{"a": 1} // done')).toEqual({ a: 1 });
  });

  it('answers undefined for a document nested deeper than the parser can walk', () => {
    const deep = `${'['.repeat(200_000)}${']'.repeat(200_000)}`;
    expect(() => parseJsonc(deep)).not.toThrow();
  });
});

describe('stripJsonc', () => {
  it('keeps every offset, so a line found in the stripped text is the line in the file', () => {
    const text = '{\n  // c\n  "a": 1, /* x\n y */\n}';
    const stripped = stripJsonc(text);
    expect(stripped).toHaveLength(text.length);
    expect(stripped.split('\n')).toHaveLength(text.split('\n').length);
  });
});

describe('lineOf', () => {
  const text = ['{', '  "hooks": {', '    "SessionStart": [', '      "node x.mjs"', ']}}'].join(
    '\n',
  );

  it('finds the line of the last needle, each searched after the one before', () => {
    expect(lineOf(text, ['"hooks"', '"SessionStart"', '"node x.mjs"'])).toBe(4);
    expect(lineOf(text, ['"hooks"'])).toBe(2);
  });

  it('skips a needle it cannot find and keeps the line of the last one found', () => {
    expect(lineOf(text, ['"hooks"', '"missing"'])).toBe(2);
    expect(lineOf(text, ['"missing"'])).toBe(1);
  });

  it('does not count a needle that only appears in a comment', () => {
    const commented = '{\n// "SessionStart"\n"SessionStart": 1}';
    expect(lineOf(stripJsonc(commented), ['"SessionStart"'])).toBe(3);
  });
});
