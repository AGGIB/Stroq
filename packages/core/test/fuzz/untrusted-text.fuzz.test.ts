import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  extractSubstitutions,
  splitPipelines,
  splitSegments,
  tokenize,
} from '../../src/actions/shell-segments.js';
import { collectKeyedStrings, collectStrings, mapStrings } from '../../src/cloak/json-strings.js';
import { compileNameMatcher, nameNeedles } from '../../src/cloak/prose-names.js';
import { expandVariants, normalizeText } from '../../src/normalize/normalizer.js';
import { neutralizeControls } from '../../src/util/controls.js';

/**
 * Property tests for the code that reads text an attacker wrote: shell commands the
 * model produced, tool output, JSON a server returned. Example tests check the cases
 * someone thought of; these generate the ones nobody did, and fail on a throw, a
 * wrong answer, or a call slow enough to matter inside a hook.
 */

/** Characters that change how a shell or a parser reads a line. */
const SHELL_CHARS = [
  ...'|;&<>()$`"\'\\ \n\t={}[]#*?~!',
  'a',
  'b',
  'x',
  'cat',
  'curl',
  'sh',
  'bash',
  'EOF',
  'eval',
  '-c',
  '/',
  '.',
  '0',
  '1',
];
const shellish = (maxLength: number) =>
  fc.array(fc.constantFrom(...SHELL_CHARS), { maxLength }).map((parts) => parts.join(''));

/** Fails when one call takes longer than a hook can afford. */
function fast<T>(fn: () => T, ms = 250): T {
  const started = performance.now();
  const out = fn();
  expect(performance.now() - started).toBeLessThan(ms);
  return out;
}

describe('shell segmentation on arbitrary commands', () => {
  it('never throws and stays fast', () => {
    fc.assert(
      fc.property(fc.oneof(shellish(400), fc.string({ maxLength: 400 })), (command) => {
        fast(() => splitSegments(command));
        fast(() => splitPipelines(command));
        fast(() => extractSubstitutions(command));
        for (const segment of splitSegments(command)) fast(() => tokenize(segment));
      }),
      { numRuns: 400 },
    );
  });
});

describe('normalization on arbitrary text', () => {
  it('never throws and stays within the scan budget', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000, unit: 'binary' }), (text) => {
        fast(() => normalizeText(text), 500);
        fast(() => expandVariants(text), 500);
      }),
      { numRuns: 200 },
    );
  });
});

describe('JSON leaf walking on arbitrary server results', () => {
  it('rewrites nothing when the rewrite is identity', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 6 }), (value) => {
        expect(mapStrings(value, (s) => s)).toEqual(value);
      }),
    );
  });

  it('sees every string leaf, and a key it reports is a key the value has', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 6 }), (value) => {
        const leaves = collectStrings(value);
        const serialised = JSON.stringify(value);
        for (const leaf of leaves) expect(serialised).toContain(JSON.stringify(leaf).slice(1, -1));
        const keyed = collectKeyedStrings(value);
        expect([...keyed.keys()].sort()).toEqual([...new Set(leaves)].sort());
      }),
    );
  });

  it('survives nesting far past its depth bound', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 5000; i += 1) deep = { k: [deep] };
    expect(() => fast(() => collectStrings(deep))).not.toThrow();
    expect(() => fast(() => mapStrings(deep, (s) => s.toUpperCase()))).not.toThrow();
  });
});

describe('neutralizeControls on arbitrary text', () => {
  const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

  it('leaves no control character behind', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 500 }), (text) => {
        expect(UNSAFE.test(neutralizeControls(text))).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  // The claim `--json` output rests on: neutralizing serialised JSON must still
  // decode to exactly the original value.
  it('keeps serialised JSON decoding to the original value', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), (value) => {
        // Against what JSON itself makes of the value: `-0` serialises as `0`, and
        // no text can carry the difference.
        const asJson: unknown = JSON.parse(JSON.stringify(value));
        expect(JSON.parse(neutralizeControls(JSON.stringify(value)))).toEqual(asJson);
      }),
      { numRuns: 300 },
    );
  });
});

describe('prose-name matching on arbitrary names and text', () => {
  it('returns non-overlapping spans that are exactly what the text holds', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 8 }),
        fc.string({ maxLength: 400 }),
        (names, text) => {
          const matcher = compileNameMatcher(nameNeedles(names));
          if (matcher === null) return;
          const spans = fast(() => matcher(text));
          let end = 0;
          for (const span of spans) {
            expect(span.start).toBeGreaterThanOrEqual(end);
            expect(text.slice(span.start, span.end)).toBe(span.value);
            end = span.end;
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
