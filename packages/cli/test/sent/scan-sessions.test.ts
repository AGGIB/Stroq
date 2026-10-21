import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyFinder, loadKeys } from '../../src/sent/keys.js';
import { scanSessions } from '../../src/sent/scan-sessions.js';
import { claudeSession as sessionRef } from '../../src/sent/sessions.js';
import {
  call,
  claudeSession,
  machine,
  PROJECT_KEY,
  type Machine,
} from '../helpers/sent-machine.js';

/**
 * One scan of many sessions reads the outputs Claude Code saved to files out of one byte budget.
 * Every value here is made up, in temporary folders.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const notice = (path: string): string =>
  `<persisted-output>\nOutput too large (5.4MB). Full output saved to: ${path}\n\nPreview (first 2KB):\nhead\n</persisted-output>`;

/** A session whose one call printed a key into a saved output. */
function sessionWithSavedKey(m: Machine, id: string): string {
  const dir = join(m.home, '.claude', 'projects', 'p', id, 'tool-results');
  const saved = join(dir, 'out.txt');
  const main = claudeSession(m, m.cwd, id, [
    ...call('a', 'Bash', { command: 'cat big.log' }, notice(saved)),
  ]);
  const own = join(dirname(main), id, 'tool-results');
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, 'out.txt'), `a long log\n${PROJECT_KEY}\n`);
  return main;
}

describe('scanSessions and saved outputs', () => {
  it('reads them out of one budget for the whole scan, and counts the ones it left', async () => {
    const m = machine();
    const first = sessionWithSavedKey(m, 's1');
    const second = sessionWithSavedKey(m, 's2');
    const finder = keyFinder(loadKeys({ home: m.home, env: {}, projectDirs: [m.cwd] }).keys);
    const result = await scanSessions([await sessionRef(first), await sessionRef(second)], {
      finder,
      mcp: { known: new Map(), lookup: () => null },
      gitRemote: () => null,
      spillBudget: 60,
    });
    expect(result.savedOutputsSkipped).toBe(1);
    const routes = result.found.map((s) => s.sightings.map((x) => x.place.route));
    // The first saved output is read and the key is tied to the call that printed it; the second
    // is past the budget, and its key is still found by the pass over the raw files, in a saved
    // output only: what some call printed.
    expect(routes).toEqual([['result'], ['result']]);
    expect(result.found[1]?.sightings[0]?.place).toEqual({
      tier: 'seen',
      route: 'result',
      spilled: true,
    });
  });
});
