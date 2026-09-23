import { describe, expect, it } from 'vitest';
import { describeEvidence } from '../../src/provenance/describe.js';
import { describeSecretHit } from '../../src/secrets/describe.js';
import { neutralizeControls } from '../../src/util/controls.js';

const ESC = '\u001b';

describe('text Stroq shows a person about attacker-written content', () => {
  // A hook reason is shown in the agent's own interface. Its evidence quotes a file
  // path and an excerpt the attacker wrote, and a raw ESC there reached that UI.
  it('carries no raw control character in a provenance sentence', () => {
    const sentence = describeEvidence(
      {
        kind: 'url',
        excerpt: `https://evil.example/${ESC}[2K${ESC}[32mapproved`,
        tool: 'Read',
        source: `/tmp/READ${ESC}[31mME.md`,
        at: '2026-09-23T10:00:00.000Z',
        suspect: true,
      },
      new Date('2026-09-23T10:00:05.000Z'),
    );
    expect(sentence).not.toContain(ESC);
    expect(sentence).toContain('\\u001b[2K');
  });

  it('carries no raw control character in a secret sentence', () => {
    const sentence = describeSecretHit({
      name: `KEY${ESC}[8m`,
      source: `/w/.env${ESC}]52;c;x`,
      canary: false,
    });
    expect(sentence).not.toContain(ESC);
  });

  it('shares one definition with the CLI', () => {
    expect(neutralizeControls(`a${ESC}b‮c\nd`)).toBe('a\\u001bb\\u202ec\nd');
  });
});
