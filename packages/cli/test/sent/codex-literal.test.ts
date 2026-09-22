import { describe, expect, it } from 'vitest';
import { readObjectLiteral } from '../../src/sent/codex-literal.js';

/**
 * The reader is measured against what Codex actually writes, not against JSON.
 * Of 2,449 object literals in the 73 rollouts on the machine this was written on,
 * 430 were valid JSON and 2,019 were not: unquoted keys, single quotes, template
 * literals, trailing commas, shorthand properties and spreads. `JSON.parse` on
 * this input answers for 18% of it.
 */
describe('readObjectLiteral', () => {
  it('reads the JSON subset', () => {
    expect(readObjectLiteral('{"cmd":"git status","timeout":5}', 0)?.value).toEqual({
      cmd: 'git status',
      timeout: 5,
    });
  });

  it('reads unquoted keys, which is the common Codex spelling', () => {
    expect(readObjectLiteral('{cmd:"ls -la",workdir:"/tmp"}', 0)?.value).toEqual({
      cmd: 'ls -la',
      workdir: '/tmp',
    });
  });

  it('reads single-quoted and backtick strings', () => {
    expect(readObjectLiteral(`{a:'one',b:\`two\`}`, 0)?.value).toEqual({ a: 'one', b: 'two' });
  });

  it('keeps an escaped quote inside the string rather than ending it', () => {
    // Seen verbatim: {cmd:"node x.js -p \"$PWD\"",workdir:"…"}
    const src = '{cmd:"node x.js -p \\"$PWD\\"",workdir:"/w"}';
    expect(readObjectLiteral(src, 0)?.value).toEqual({
      cmd: 'node x.js -p "$PWD"',
      workdir: '/w',
    });
  });

  it('reads nested objects, arrays, booleans, null and negative numbers', () => {
    const src = '{plan:[{step:"a",done:true},{step:"b",done:false}],n:-2.5,x:null}';
    expect(readObjectLiteral(src, 0)?.value).toEqual({
      plan: [
        { step: 'a', done: true },
        { step: 'b', done: false },
      ],
      n: -2.5,
      x: null,
    });
  });

  it('tolerates trailing commas and newlines between entries', () => {
    expect(readObjectLiteral('{\n  a: 1,\n  b: 2,\n}', 0)?.value).toEqual({ a: 1, b: 2 });
  });

  it('records a shorthand property as present with no value', () => {
    // {calendar_id, time_min:"…"} — the name is still evidence that the call
    // carried that field, and dropping the whole literal over it would lose the
    // fields that do have values.
    expect(readObjectLiteral('{calendar_id,time_min:"2026-09-12"}', 0)?.value).toEqual({
      calendar_id: null,
      time_min: '2026-09-12',
    });
  });

  it('skips a spread rather than failing the whole literal', () => {
    expect(readObjectLiteral('{...base,title:"x"}', 0)?.value).toEqual({ title: 'x' });
  });

  it('keeps an interpolated template as its source text', () => {
    // The value is not knowable without running the script, so the text is kept
    // verbatim: a credential spliced into a template is still found by a scan of it.
    expect(readObjectLiteral('{start:`${date}T09:00`}', 0)?.value).toEqual({
      start: '${date}T09:00',
    });
  });

  it('stops at the matching brace and reports where it ended', () => {
    const src = 'tools.exec_command({cmd:"ls"}))';
    const at = src.indexOf('{');
    const read = readObjectLiteral(src, at);
    expect(read?.value).toEqual({ cmd: 'ls' });
    expect(src.slice(read?.end ?? 0)).toBe('))');
  });

  it('returns null on an expression it cannot read, rather than a partial object', () => {
    // A half-read literal is worse than none: the caller falls back to the raw
    // source text, which is still scanned in full.
    expect(readObjectLiteral('{cmd: someVariable}', 0)).toBeNull();
    expect(readObjectLiteral('{cmd:"unterminated', 0)).toBeNull();
    expect(readObjectLiteral('not an object', 0)).toBeNull();
  });
});
