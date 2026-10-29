import { describe, expect, it } from 'vitest';
import { unsafeCodePoints } from './shell';
import {
  hiddenCharacterError,
  hiddenReviewCharacter,
  isHiddenCharacterError,
  taskAccessReviewText,
  validateTaskAccessReview,
} from './task-access-review';
const base = () => ({
  v: 1,
  tool: 'Read',
  kind: 'read-target',
  input: { file_path: '/work/file' },
  cwd: '/work',
  resources: {
    paths: [{ path: '/work/file', op: 'read' }],
    pathsComplete: true,
    urls: [],
    shell: false,
  },
  target: { path: '/work/file', op: 'read' },
});
describe('complete one-use review boundary', () => {
  it('accepts producer Read target and complete whole-call families', () => {
    expect(validateTaskAccessReview(JSON.stringify(base()), 'Read', 'read-target')).toBe(true);
    const { target, ...whole } = base();
    expect(
      validateTaskAccessReview(
        JSON.stringify({
          ...whole,
          kind: 'whole-call',
          tool: 'Bash',
          input: { command: 'printf ok' },
          resources: null,
        }),
        'Bash',
        'whole-call',
      ),
    ).toBe(true);
  });
  it('refuses partial or cross-bound operation/target/context records', () => {
    for (const value of [
      {},
      { ...base(), v: 2 },
      { ...base(), tool: 'Bash' },
      { ...base(), kind: 'whole-call' },
      { ...base(), input: [] },
      { ...base(), cwd: '' },
      { ...base(), resources: [] },
      { ...base(), resources: null },
      { ...base(), target: { path: '/different', op: 'read' } },
      { ...base(), target: { path: '/work/file', op: 'write' } },
      { ...base(), nonce: 'private' },
    ])
      expect(validateTaskAccessReview(JSON.stringify(value), 'Read', 'read-target')).toBe(false);
  });
  it('rejects duplicate and escaped duplicate keys, prototype fields, oversized and deep JSON', () => {
    const raw = JSON.stringify(base());
    for (const value of [
      raw.replace('"v":1', '"v":1,"v":1'),
      raw.replace('"v":1', '"v":1,"\\u0076":1'),
      raw.replace('"input":{', '"input":{"__proto__":{},'),
      raw.replace('"input":{', '"input":{"deep":' + '['.repeat(33) + '0' + ']'.repeat(33) + ','),
      JSON.stringify({ ...base(), input: { large: 'x'.repeat(65536) } }),
    ])
      expect(validateTaskAccessReview(value, 'Read', 'read-target')).toBe(false);
  });
  it('requires exact resource fields and preserves safe readable structured context', () => {
    for (const resources of [
      { ...base().resources, shell: 'yes' },
      { ...base().resources, paths: [{ path: '/work/file', op: 'execute' }] },
      {
        ...base().resources,
        urls: [{ url: 'https://example.test/', host: 'example.test', raw: 'private' }],
      },
      { ...base().resources, paths: [{ path: '/work/file', op: 'read', real: '/work/real' }] },
    ])
      expect(
        validateTaskAccessReview(JSON.stringify({ ...base(), resources }), 'Read', 'read-target'),
      ).toBe(false);
  });
});
// Every character is built from its number, so no editor or formatter can hide one in this file.
const char = (code: number) => String.fromCodePoint(code);
/** The JSON escape of one character (a backslash, `u` and four hex digits), or of its two halves. */
const escaped = (code: number) =>
  [...char(code)]
    .flatMap((c) => [c.charCodeAt(0), ...(c.length > 1 ? [c.charCodeAt(1)] : [])])
    .map((unit) => `\\u${unit.toString(16).padStart(4, '0')}`)
    .join('');
const call = (input: Record<string, unknown>) =>
  JSON.stringify({ v: 1, tool: 'Bash', kind: 'whole-call', input, cwd: '/work', resources: null });
/** What the review screen would not show as it is: bidi, marks, zero-width, C1, separators, tags. */
const HIDDEN = [
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x200b,
  0x200c, 0x200d, 0x2060, 0xfeff, 0x85, 0x9b, 0x2028, 0x2029, 0xe0041,
];
describe('the review screen shows exactly the text that is signed', () => {
  it('refuses a hidden character in a value, in a key, and written as a JSON escape', () => {
    for (const code of HIDDEN) {
      const inValue = call({ command: `printf a${char(code)}b` });
      const inKey = call({ [`command${char(code)}`]: 'printf ab' });
      const asEscape = call({ command: 'printf X' }).replace('X', escaped(code));
      for (const text of [inValue, inKey, asEscape]) {
        expect(hiddenReviewCharacter(text)).toBe(code);
        expect(validateTaskAccessReview(text, 'Bash', 'whole-call')).toBe(false);
      }
    }
  });
  it('refuses one in the working folder and in the path of a read target', () => {
    const cwd = JSON.stringify({ ...base(), cwd: `/work${char(0x200b)}` });
    expect(hiddenReviewCharacter(cwd)).toBe(0x200b);
    expect(validateTaskAccessReview(cwd, 'Read', 'read-target')).toBe(false);
    const path = `/work/file${char(0x202e)}txt.exe`;
    const target = JSON.stringify({
      ...base(),
      input: { file_path: path },
      resources: { ...base().resources, paths: [{ path, op: 'read' }] },
      target: { path, op: 'read' },
    });
    expect(hiddenReviewCharacter(target)).toBe(0x202e);
    expect(validateTaskAccessReview(target, 'Read', 'read-target')).toBe(false);
  });
  it('accepts visible text, and shows controls as the escapes JSON writes', () => {
    const visible = [0xe9, 0x65e5, 0x2714, 0xfe0f].map(char).join('');
    const text = call({ command: `printf '${visible}\t\n'` });
    expect(hiddenReviewCharacter(text)).toBeNull();
    expect(validateTaskAccessReview(text, 'Bash', 'whole-call')).toBe(true);
    const shown = taskAccessReviewText(text);
    expect(shown).toBe(JSON.stringify(JSON.parse(text), null, 2));
    expect(shown).toContain(`${visible}\\t\\n`);
  });
  it('shows no hidden character in the text of any review it accepts', () => {
    let accepted = 0;
    for (const code of unsafeCodePoints()) {
      const text = call({ command: 'printf X' }).replace('X', escaped(code));
      if (!validateTaskAccessReview(text, 'Bash', 'whole-call')) continue;
      accepted += 1;
      // Only a control that JSON writes back as an escape passes, and it is shown as that escape.
      expect(code).toBeLessThan(0x20);
      const line = taskAccessReviewText(text)
        .split('\n')
        .find((row) => row.includes('"command"'))!;
      expect(line.includes(char(code))).toBe(false);
      expect(line).toMatch(/"printf \\/);
    }
    expect(accepted).toBeGreaterThan(0);
  });
  it('lets only the refusal for a character of the table through as a named refusal', () => {
    expect(hiddenCharacterError(0x202e)).toBe('hidden-character-202e');
    for (const code of HIDDEN)
      expect(isHiddenCharacterError(hiddenCharacterError(code))).toBe(true);
    for (const code of [
      'hidden-character-0041',
      'hidden-character-fe0f',
      'hidden-character-202E',
      'hidden-character-0202e',
      'hidden-character-110000',
      'hidden-character-',
      'hidden-character-202e ',
      'operation-unavailable',
      undefined,
    ])
      expect(isHiddenCharacterError(code)).toBe(false);
  });
});
