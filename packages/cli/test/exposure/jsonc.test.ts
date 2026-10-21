import fc from 'fast-check';
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

/**
 * VS Code's own reader (jsonc-parser) ends a `//` comment at any of four line breaks: `\n`, a bare
 * `\r`, U+2028 and U+2029, and reads those as blank space between tokens. A reader that ended the
 * comment only at `\n` read `"version": "2.0.0" // note<CR>, "tasks": [...]` as a file with no
 * tasks, while VS Code ran its folder-open task. `vscodeReading` is that rule written out on its
 * own, a scan of the text the way jsonc-parser's scanner walks it, and `parseJsonc` must agree.
 */
const VSCODE_BREAKS = new Set(['\n', '\r', ' ', ' ']);

function vscodeReading(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      // A comment is blank space between tokens: `1/* */1` is two numbers, not `11`.
      while (i + 1 < text.length && !VSCODE_BREAKS.has(text[i + 1] as string)) i += 1;
      out += ' ';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return undefined;
      i = end + 1;
      out += ' ';
    } else {
      out += c === ' ' || c === ' ' ? ' ' : c;
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as unknown;
  } catch {
    return undefined;
  }
}

const FOLDER_OPEN =
  '"tasks": [{"label": "x", "type": "shell", "command": "node evil.js", "runOptions": {"runOn": "folderOpen"}}]';

describe('a line comment ends where VS Code ends it', () => {
  it.each([
    ['a bare carriage return', '\r'],
    ['a line separator', ' '],
    ['a paragraph separator', ' '],
    ['a newline', '\n'],
    ['a carriage return and a newline', '\r\n'],
  ])('at %s', (_, eol) => {
    const text = `{"version": "2.0.0" // note${eol}, ${FOLDER_OPEN}}`;
    const read = parseJsonc(text);
    expect(read).toEqual(vscodeReading(text));
    expect(read).toMatchObject({ tasks: [{ runOptions: { runOn: 'folderOpen' } }] });
  });

  it('keeps a line separator inside a string as part of the string, as both readers do', () => {
    const text = '{"a": "x y" // c , "b": 1}';
    expect(parseJsonc(text)).toEqual({ a: 'x y', b: 1 });
    expect(parseJsonc(text)).toEqual(vscodeReading(text));
  });

  it('agrees with that reading on every mix of comments, breaks and commas', () => {
    const pieces = ['{', '}', '[', ']', '"a"', '"//"', ':', '1', ',', ' ', '// c', '/* d */'];
    const breaks = ['\n', '\r', ' ', ' ', '\r\n'];
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...pieces, ...breaks), { maxLength: 24 }), (parts) => {
        const text = parts.join('');
        expect(parseJsonc(text)).toEqual(vscodeReading(text));
      }),
      { numRuns: 2000 },
    );
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
