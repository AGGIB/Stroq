import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashSecret } from '@stroq/core';
import { canaryValuesInFile, plantedCanaries } from '../../src/sent/canaries.js';
import type { KeySet } from '../../src/sent/keys.js';
import { NAME_NOT_SHOWN } from '../../src/sent/names.js';
import {
  CANARY_SOURCE,
  MAX_CHECKS_PER_FILE,
  withSessionCanaries,
} from '../../src/sent/session-canaries.js';
import type { SessionRef } from '../../src/sent/sessions.js';
import { treeOf } from '../helpers/tree.js';

/**
 * A canary `stroq canary` printed for the user to paste is stored only as a salted hash. One that
 * turns up in a session is found by its shape there and confirmed against that hash, read-only.
 * Every value here is made up, in temporary folders.
 */

const CANARY = 'stroq_canary_FAKEcanary0123456789abcdefABCDEF';
const OTHER = 'stroq_canary_FAKEnotPlanted0123456789abcdefAB';
const SALT = 'fakesalt0123456789';

const EMPTY: KeySet = {
  keys: [],
  files: [],
  paths: [],
  envKeys: 0,
  unreadable: 0,
  truncated: false,
  partial: [],
  skippedFiles: 0,
  rejectedLines: 0,
  subfolderEnvFiles: 0,
  canariesNotFound: 0,
};

function stroqHome(planted: readonly { value: string; name: string }[]): string {
  const home = mkdtempSync(join(tmpdir(), 'stroq-sent-session-canaries-'));
  writeFileSync(
    join(home, 'secrets.json'),
    JSON.stringify({
      salt: SALT,
      canaries: planted.map((c) => ({ hash: hashSecret(SALT, c.value), name: c.name })),
    }),
  );
  return home;
}

function sessionFile(text: string): SessionRef {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-sent-session-canaries-s-'));
  const path = join(dir, 's.jsonl');
  writeFileSync(path, text);
  return { agent: 'claude-code', path, files: [path], cwd: null, first: null, mtimeMs: 0 };
}

describe('plantedCanaries', () => {
  it('reads the salt and the name of each planted canary, never a value', () => {
    const home = stroqHome([{ value: CANARY, name: 'decoy_token' }]);
    const planted = plantedCanaries(home);
    expect(planted?.salt).toBe(SALT);
    expect([...(planted?.names.values() ?? [])]).toEqual(['decoy_token']);
    expect(plantedCanaries(join(home, 'missing'))).toBeNull();
  });
});

describe('canaryValuesInFile', () => {
  it('finds each canary-shaped value, also across the edge of a read', () => {
    const ref = sessionFile(`${'x'.repeat(30)}${CANARY}","more":"${OTHER}\nstroq_canary_short`);
    const seen: string[] = [];
    canaryValuesInFile(ref.path, (v) => (seen.push(v), true), 16);
    expect(seen).toEqual([CANARY, OTHER]);
  });
});

describe('withSessionCanaries', () => {
  it('adds a canary found in a session whose hash was planted, under its planted name', () => {
    const home = stroqHome([
      { value: CANARY, name: 'decoy_token' },
      { value: 'stroq_canary_FAKEneverSeen0123456789abcdefABC', name: 'STROQ_CANARY_KEY' },
    ]);
    const refs = [sessionFile(`{"text":"saw ${CANARY} and ${OTHER}"}\n`)];
    const before = treeOf(home);
    const set = withSessionCanaries(EMPTY, refs, home);
    expect(set.keys).toEqual([
      { name: 'decoy_token', source: CANARY_SOURCE, value: CANARY, canary: true },
    ]);
    // The canary that is in no file and no session is still counted as not looked for.
    expect(set.canariesNotFound).toBe(1);
    expect(treeOf(home)).toEqual(before);
  });

  it('adds nothing for a value of a canary’s shape that was not planted', () => {
    const home = stroqHome([{ value: CANARY, name: 'decoy_token' }]);
    const set = withSessionCanaries(EMPTY, [sessionFile(`saw ${OTHER}\n`)], home);
    expect(set.keys).toEqual([]);
    expect(set.canariesNotFound).toBe(1);
  });

  it('does not read sessions for a canary it already has from a file', () => {
    const home = stroqHome([{ value: CANARY, name: 'decoy_token' }]);
    const known: KeySet = {
      ...EMPTY,
      keys: [{ name: 'STROQ_CANARY_KEY', source: '~/x.env', value: CANARY, canary: true }],
      canariesNotFound: 0,
    };
    const set = withSessionCanaries(known, [sessionFile(`saw ${CANARY}\n`)], home);
    expect(set.keys).toHaveLength(1);
    expect(set.canariesNotFound).toBe(0);
  });

  it('prints a planted name only when it has the shape of one', () => {
    const home = stroqHome([{ value: CANARY, name: 'EVIL\u001b[2J_KEY' }]);
    const set = withSessionCanaries(EMPTY, [sessionFile(`saw ${CANARY}\n`)], home);
    expect(set.keys[0]?.name).toBe(NAME_NOT_SHOWN);
  });

  // A session can hold as many values of a canary's shape as it likes: each file is hashed to a
  // budget of its own, so a flood in one cannot end the check for the sessions after it, and a
  // file cut short is counted, as it may be tampering.
  it('keeps checking the next session after a flood of canary-shaped values in one', () => {
    const home = stroqHome([{ value: CANARY, name: 'decoy_token' }]);
    const flood = Array.from(
      { length: MAX_CHECKS_PER_FILE + 1 },
      (_, i) => `stroq_canary_FAKEflood${String(i).padStart(23, '0')}`,
    ).join(' ');
    const refs = [sessionFile(`${flood}\n`), sessionFile(`saw ${CANARY}\n`)];
    const set = withSessionCanaries(EMPTY, refs, home);
    expect(set.keys.map((k) => k.value)).toEqual([CANARY]);
    expect(set.canariesNotFound).toBe(0);
    expect(set.canaryCheckCut).toBe(1);
  });

  it('counts no cut when every value of a file was checked', () => {
    const home = stroqHome([{ value: CANARY, name: 'decoy_token' }]);
    const set = withSessionCanaries(EMPTY, [sessionFile(`saw ${OTHER} ${OTHER}\n`)], home);
    expect(set.canaryCheckCut ?? 0).toBe(0);
  });

  it('reads the rows of a Cursor session as it reads files', () => {
    const home = stroqHome([{ value: CANARY, name: 'decoy_token' }]);
    const ref: SessionRef = {
      agent: 'cursor',
      path: '/db#s',
      files: [],
      cwd: null,
      first: null,
      mtimeMs: 0,
      cursor: {
        transcript: { sessionId: 's', cwd: null, events: [], skipped: 0 },
        rows: [`{"text":"${CANARY}"}`],
      },
    };
    expect(withSessionCanaries(EMPTY, [ref], home).keys).toHaveLength(1);
  });
});
