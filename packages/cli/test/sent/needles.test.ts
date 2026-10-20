import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { byteMatcher, keyForms, textMatcher } from '../../src/sent/needles.js';
import { cpuNow } from '../helpers/cpu-time.js';

/**
 * Exact matching of known values, in memory. Every value is made up for the test.
 */

const PLAIN = 'FAKEplainValue0123456789abcdef';
const BASE64 = 'FAKE+b64/Value==0123456789';
const QUOTED = 'FAKE"quoted\\value0123456789';

describe('keyForms', () => {
  it('is the value, its JSON-escaped form and its URL-encoded form, each once', () => {
    expect(keyForms(PLAIN)).toEqual([PLAIN]);
    expect(keyForms(BASE64)).toEqual([BASE64, encodeURIComponent(BASE64)]);
    expect(keyForms(QUOTED)).toEqual([
      QUOTED,
      JSON.stringify(QUOTED).slice(1, -1),
      encodeURIComponent(QUOTED),
      // As a shell command joins it, its quotes and backslashes taken out.
      'FAKEquotedvalue0123456789',
    ]);
  });
});

describe('textMatcher', () => {
  const matcher = textMatcher([PLAIN, BASE64, QUOTED]);

  it('finds a value glued into a URL path, which a token match missed', () => {
    expect([...matcher.find(`curl https://hooks.example.test/in/${PLAIN}/end`)]).toEqual([0]);
  });

  it('finds the URL-encoded form', () => {
    expect([...matcher.find(`GET /?k=${encodeURIComponent(BASE64)}&x=1`)]).toEqual([1]);
  });

  it('finds the JSON-escaped form inside JSON text', () => {
    expect([...matcher.find(JSON.stringify({ token: QUOTED }))]).toEqual([2]);
  });

  it('finds several keys in one text, and none in a text without them', () => {
    expect([...matcher.find(`${QUOTED} then ${PLAIN}`)].sort()).toEqual([0, 2]);
    expect(matcher.find('nothing to see here, FAKEplainValue0123 only half').size).toBe(0);
  });

  it('never matches a value shorter than the minimum length', () => {
    const short = textMatcher(['short12345', PLAIN]);
    expect(short.find('a short12345 b').size).toBe(0);
    expect([...short.find(PLAIN)]).toEqual([1]);
  });

  it('finds a value at the very start and at the very end of a text', () => {
    expect([...matcher.find(PLAIN)]).toEqual([0]);
    expect([...matcher.find(`xx${PLAIN}`)]).toEqual([0]);
    expect([...matcher.find(`${PLAIN}xx`)]).toEqual([0]);
  });

  it('agrees with a plain substring search on random texts', () => {
    const values = [PLAIN, BASE64, 'FAKEotherKey_9876543210zz'];
    const m = textMatcher(values);
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.string(), fc.constantFrom(...values, 'FAKEplain', '0123456789')), {
          maxLength: 12,
        }),
        (parts) => {
          const text = parts.join('');
          const expected = values.flatMap((v, i) =>
            keyForms(v).some((f) => text.includes(f)) ? [i] : [],
          );
          expect([...m.find(text)].sort()).toEqual(expected);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('byteMatcher', () => {
  const file = (text: string): string => {
    const path = join(mkdtempSync(join(tmpdir(), 'stroq-sent-needles-')), 'session.jsonl');
    writeFileSync(path, text);
    return path;
  };

  it('finds a value in a JSON line as Claude Code writes it, escaped once more', () => {
    const line = JSON.stringify({ message: { content: JSON.stringify({ token: QUOTED }) } });
    expect([...byteMatcher([PLAIN, QUOTED]).findInFile(file(`${line}\n`))]).toEqual([1]);
  });

  it('finds a value that straddles two reads', () => {
    const text = `${'x'.repeat(100)}${PLAIN}${'y'.repeat(100)}`;
    const path = file(text);
    for (const chunk of [64, 107, 110, 113, 4096]) {
      expect([...byteMatcher([PLAIN]).findInFile(path, chunk)], `chunk ${chunk}`).toEqual([0]);
    }
  });

  it('finds a non-ASCII value by its UTF-8 bytes', () => {
    const value = 'FAKEпарольЗначение0123';
    expect([...byteMatcher([value]).findInFile(file(`a ${value} b`))]).toEqual([0]);
  });

  it('finds nothing in a file without the values, and says when a file could not be read', () => {
    const m = byteMatcher([PLAIN]);
    const clean = m.scanFile(file('nothing here at all, not even FAKEplainValue012345'));
    expect(clean.keys).toEqual(new Set());
    expect(clean.failed).toBe(false);
    // Half of a value makes the file worth parsing (a key split in two by quotes), not a finding.
    expect(clean.triggered).toBe(true);
    const missing = m.scanFile(join(tmpdir(), 'stroq-no-such-file-here.jsonl'));
    expect(missing).toEqual({ keys: new Set(), failed: true });
  });
});

describe('many keys that begin alike, in a text that repeats their beginning', () => {
  // An attacker's repository can hold thousands of keys that share their first 64 characters,
  // and a session can repeat those characters for megabytes: each place they occur is one lookup.
  const prefix = 'FAKEflood'.padEnd(64, 'x');
  const keys = Array.from({ length: 2000 }, (_, i) => `${prefix}${String(i).padStart(10, 'q')}`);
  const text = prefix.repeat(32_000);

  it('the text matcher reads 2 MB of it in well under a second', () => {
    const matcher = textMatcher(keys);
    const started = cpuNow();
    expect(matcher.find(text).size).toBe(0);
    expect(cpuNow() - started).toBeLessThan(1500);
    expect(matcher.find(`${text}${keys[1999]}`)).toEqual(new Set([1999]));
  });

  it('the byte matcher reads 2 MB of it in well under a second', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'stroq-sent-flood-')), 'session.jsonl');
    writeFileSync(path, `${text}${keys[7]}`);
    const started = cpuNow();
    expect([...byteMatcher(keys).findInFile(path)]).toEqual([7]);
    expect(cpuNow() - started).toBeLessThan(1500);
  });

  it('a search past its bound stops, and says it was cut', () => {
    // A key that runs far past a shared beginning: what follows each place it begins is read to
    // its length before it can be told apart.
    const matcher = textMatcher([`${prefix}${'q'.repeat(100_000)}`]);
    const started = cpuNow();
    matcher.find(prefix.repeat(65_536));
    expect(cpuNow() - started).toBeLessThan(5000);
    expect(matcher.cuts()).toBe(1);
  });
});
