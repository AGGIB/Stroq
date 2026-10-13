import { describe, expect, it } from 'vitest';
import { checkEntryPath } from '../../src/install/safe-path.js';
import { escapeHtml, safe } from '../../src/replay/html.js';

// safe-path.ts decides what a path may not contain by Unicode property (see safe-path-characters.test.ts
// for that), and shows a refused path with its own escapes. The two helpers that write characters out
// for display (`neutralizeControls` in core, `showInvisible` in replay/html.ts) are not exported to
// share, so they are asked here, for every code point there is: a path that passes the check is also
// shown by them as it is. If one of them learns a character that the check does not refuse, a path
// with it would be written to a disk and then shown to a person unescaped, and the day comes up as a
// failure here.

const SURROGATES = { first: 0xd800, last: 0xdfff } as const;
const LAST_CODE_POINT = 0x10ffff;

describe('the characters an entry path may not contain', () => {
  it('include every character that the terminal-safety code or the replay page writes out', () => {
    const missed: string[] = [];
    let writtenOut = 0;

    for (let code = 0; code <= LAST_CODE_POINT; code += 1) {
      if (code >= SURROGATES.first && code <= SURROGATES.last) continue;
      const ch = String.fromCodePoint(code);
      // `safe` is neutralizeControls, then showInvisible, then HTML escaping: a character it
      // changes, beyond what the HTML escaping alone changes, is one that is written out.
      if (safe(ch, 10) === escapeHtml(ch)) continue;
      writtenOut += 1;
      if (checkEntryPath(`a${ch}b`).ok) missed.push(`U+${code.toString(16).padStart(4, '0')}`);
    }

    expect(missed).toEqual([]);
    // The sweep must have found something to compare with, or it proves nothing.
    expect(writtenOut).toBeGreaterThan(300);
  });

  it('do not refuse ordinary printable ASCII, apart from what a path may not hold', () => {
    const refused: string[] = [];
    // The backslash, the colon, and the six characters Windows does not allow in a name.
    const notAllowed = new Set(['\\', ':', '<', '>', '"', '|', '?', '*']);

    for (let code = 0x20; code <= 0x7e; code += 1) {
      const ch = String.fromCharCode(code);
      if (notAllowed.has(ch)) continue;
      if (!checkEntryPath(`a${ch}b`).ok) refused.push(JSON.stringify(ch));
    }

    expect(refused).toEqual([]);
  });
});
