import { describe, expect, it } from 'vitest';
import { secretSpans } from '../src/cloak/secret-spans.js';
import { candidatesFromText, candidateTokens } from '../src/secrets/candidates.js';
import type { SecretMatch } from '../src/types.js';

const match = (token: string, raw = token): SecretMatch => ({
  name: 'DEMO_API_KEY',
  source: '.env',
  canary: false,
  token,
  raw,
});

describe('candidatesFromText', () => {
  it('tokenises bare text the same way the tool-input path does', () => {
    const text = 'aws_secret_access_key=wJalrXUtnFEMIK7MDENG';
    const fromText = candidatesFromText(text).map((c) => c.token);
    expect(fromText).toContain('wJalrXUtnFEMIK7MDENG');
    // The existing entry point is now this function plus a text extractor, so the two
    // can never drift apart in what counts as a candidate.
    const viaTool = candidateTokens('Bash', { command: text }).map((c) => c.token);
    expect(fromText.sort()).toEqual(viaTool.sort());
  });

  it('yields nothing for empty text', () => {
    expect(candidatesFromText('')).toEqual([]);
  });
});

describe('secretSpans', () => {
  it('places a match at the offset where its raw spelling actually occurs', () => {
    const text = 'the key is wJalrXUtnFEMIK7MDENG, keep it safe';
    const spans = secretSpans(text, [match('wJalrXUtnFEMIK7MDENG')]);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe('wJalrXUtnFEMIK7MDENG');
    expect(spans[0]!.kind).toBe('secret');
    expect(spans[0]!.restorable).toBe(false);
    expect(spans[0]!.label).toBe('DEMO_API_KEY (.env)');
  });

  it('finds every occurrence of the same value', () => {
    const text = 'wJalrXUtnFEMIK7MDENG and wJalrXUtnFEMIK7MDENG';
    expect(secretSpans(text, [match('wJalrXUtnFEMIK7MDENG')])).toHaveLength(2);
  });

  it('finds the url-encoded spelling of a value whose decoded form was the match', () => {
    const decoded = 'wJalrX/UtnFEMIK7';
    const text = `payload=${encodeURIComponent(decoded)}&next=1`;
    const spans = secretSpans(text, [match(decoded, encodeURIComponent(decoded))]);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe(encodeURIComponent(decoded));
  });

  it('reports NO span for a match whose spellings do not literally occur in the text', () => {
    // The whole point: a match that cannot be PLACED is never cloaked at a guessed
    // offset. Reporting nothing leaves the value alone; reporting a wrong offset
    // would corrupt the payload.
    expect(secretSpans('nothing here at all', [match('wJalrXUtnFEMIK7MDENG')])).toEqual([]);
  });

  it('ignores an empty token rather than matching at every position', () => {
    expect(secretSpans('abc', [match('', '')])).toEqual([]);
  });
});
