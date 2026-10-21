import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_FOLDER_BYTES,
  MAX_FOLDER_ENV_FILES,
  MAX_FOLDER_KEYS,
  MAX_KEY_FILE_BYTES,
  loadKeys,
} from '../../src/sent/keys.js';

/**
 * A folder a session ran in can hold `.env` files a repository or the agent wrote, and the agent
 * can append to the user's own. None of that may push a key out of the comparison in silence:
 * the keys of the home files and the environment are always compared, one folder's junk cannot
 * crowd out another's keys, and whatever was not read is said. Every value here is made up.
 */

const ENV_KEY = 'sk-FAKEenvOpenai0123456789abcdef';
const OTHER = 'FAKEotherFolderKey0123456789abc';

const junk = (prefix: string, n: number): string =>
  Array.from(
    { length: n },
    (_, i) => `API_KEY_${prefix}${i}=Zq${prefix}${String(i).padStart(8, '0')}abcdefGHIJKL`,
  ).join('\n');

function dirs(): { home: string; evil: string; other: string } {
  const root = mkdtempSync(join(tmpdir(), 'stroq-sent-caps-'));
  const home = join(root, 'home');
  const evil = join(root, 'evil');
  const other = join(root, 'other');
  for (const d of [home, evil, other]) mkdirSync(d, { recursive: true });
  return { home, evil, other };
}

describe('loadKeys under junk', () => {
  it('compares the environment and the other folders however many keys one folder holds', () => {
    const { home, evil, other } = dirs();
    for (const name of ['a', 'b', 'c'])
      writeFileSync(join(evil, `.env.${name}`), junk(name, 5_000));
    writeFileSync(join(other, '.env'), `OTHER_SECRET=${OTHER}\n`);
    const set = loadKeys({ home, env: { OPENAI_API_KEY: ENV_KEY }, projectDirs: [evil, other] });
    const values = new Set(set.keys.map((k) => k.value));
    expect(values.has(ENV_KEY)).toBe(true);
    expect(values.has(OTHER)).toBe(true);
    expect(set.keys.filter((k) => k.source.startsWith(evil))).toHaveLength(MAX_FOLDER_KEYS);
    // The keys left out are said: the run was cut, and the files that held them are named.
    expect(set.truncated).toBe(true);
    expect(MAX_FOLDER_KEYS).toBeLessThan(5_000);
    expect(set.partial).toEqual(['a', 'b', 'c'].map((n) => join(evil, `.env.${n}`)));
    expect(set.envKeys).toBe(1);
  });

  it('finds a key behind 300 KB of padding or 5,001 lines', () => {
    const { home, evil } = dirs();
    writeFileSync(
      join(evil, '.env'),
      `API_KEY=FAKEbeforePadding0123456789\n${'#'.repeat(300_000)}\n`,
    );
    writeFileSync(
      join(evil, '.env.local'),
      `${'# pad\n'.repeat(5_001)}SECRET_TOKEN=FAKEafterLines0123456789\n`,
    );
    const set = loadKeys({ home, env: {}, projectDirs: [evil] });
    expect(set.keys.map((k) => k.name).sort()).toEqual(['API_KEY', 'SECRET_TOKEN']);
    expect(set.partial).toEqual([]);
    expect(set.truncated).toBe(false);
  });

  it('names a key file too large to read whole, and still reads its start', () => {
    const { home, evil } = dirs();
    const file = join(evil, '.env');
    writeFileSync(
      file,
      `API_KEY=FAKEatTheStart0123456789\n${'#'.repeat(MAX_KEY_FILE_BYTES)}\nLATE_TOKEN=FAKEatTheEnd0123456789\n`,
    );
    const set = loadKeys({ home, env: {}, projectDirs: [evil] });
    expect(set.keys.map((k) => k.name)).toEqual(['API_KEY']);
    expect(set.partial).toEqual([file]);
  });

  it('names a home key file too large for its own reader', () => {
    const { home, evil } = dirs();
    writeFileSync(
      join(home, '.netrc'),
      `${'x '.repeat(20_001)}machine a.test password FAKEnetrc0123456789\n`,
    );
    const set = loadKeys({ home, env: {}, projectDirs: [evil] });
    expect(set.partial).toEqual(['~/.netrc']);
  });

  // A folder of large `.env` files is read up to a number of bytes, not a number of files times
  // their size: past it the rest are counted, the file cut by it is named, and the next folder is
  // still read in full.
  it('reads one folder only up to its budget of bytes, and says what it left', () => {
    const { home, evil, other } = dirs();
    const third = Math.ceil(MAX_FOLDER_BYTES / 3);
    const files = ['a', 'b', 'c', 'd'].map((n) => join(evil, `.env.${n}`));
    files.forEach((file, i) =>
      writeFileSync(file, `API_KEY_${i}=FAKEbudget${i}0123456789\n${'#'.repeat(third)}\n`),
    );
    writeFileSync(join(other, '.env'), `OTHER_SECRET=${OTHER}\n`);
    const set = loadKeys({ home, env: {}, projectDirs: [evil, other] });
    expect(set.keys.map((k) => k.name).sort()).toEqual([
      'API_KEY_0',
      'API_KEY_1',
      'API_KEY_2',
      'OTHER_SECRET',
    ]);
    expect(set.partial).toEqual([files[2]]);
    expect(set.skippedFiles).toBe(1);
  });

  it('counts the .env files of a folder past the number it reads', () => {
    const { home, evil } = dirs();
    for (let i = 0; i < MAX_FOLDER_ENV_FILES + 3; i += 1)
      writeFileSync(join(evil, `.env.${String(i).padStart(4, '0')}`), 'PORT=3000\n');
    const set = loadKeys({ home, env: {}, projectDirs: [evil] });
    expect(set.skippedFiles).toBe(3);
  });

  it('names a key in both the environment and a .env file after the file', () => {
    const { home, evil } = dirs();
    writeFileSync(join(evil, '.env'), `OPENAI_API_KEY=${ENV_KEY}\n`);
    const set = loadKeys({ home, env: { OPENAI_API_KEY: ENV_KEY }, projectDirs: [evil] });
    expect(set.keys).toHaveLength(1);
    expect(set.keys[0]?.source).toBe(join(evil, '.env'));
    expect(set.files).toEqual([join(evil, '.env')]);
    expect(set.envKeys).toBe(0);
  });
});
