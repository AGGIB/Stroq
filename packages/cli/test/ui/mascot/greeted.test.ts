import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GREETED_FILE_NAME,
  greetedFileIn,
  hasGreeted,
  markGreeted,
} from '../../../src/ui/mascot/greeted.js';

const isWindows = process.platform === 'win32';

let scratch = '';
let savedHome: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'stroq-mascot-greeted-'));
  savedHome = process.env['STROQ_HOME'];
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['STROQ_HOME'];
  else process.env['STROQ_HOME'] = savedHome;
  rmSync(scratch, { recursive: true, force: true });
});

const homeIn = (name = 'home'): string => join(scratch, name);

describe('the marker file', () => {
  it('is an empty file called mascot-greeted in the Stroq home', () => {
    expect(GREETED_FILE_NAME).toBe('mascot-greeted');
    expect(greetedFileIn('/h')).toBe(join('/h', 'mascot-greeted'));
  });
});

describe('hasGreeted', () => {
  it('is false when there is no marker, whether or not the home exists yet', () => {
    expect(hasGreeted(homeIn())).toBe(false);
    mkdirSync(homeIn());
    expect(hasGreeted(homeIn())).toBe(false);
  });

  it('is true once the marker is there', () => {
    mkdirSync(homeIn());
    writeFileSync(greetedFileIn(homeIn()), '');

    expect(hasGreeted(homeIn())).toBe(true);
  });

  it('reads STROQ_HOME when it is not told a home', () => {
    process.env['STROQ_HOME'] = homeIn('from-env');
    expect(hasGreeted()).toBe(false);

    markGreeted();

    expect(existsSync(greetedFileIn(homeIn('from-env')))).toBe(true);
    expect(hasGreeted()).toBe(true);
  });

  it('counts an error as having been greeted, and does not throw: the home is a file', () => {
    writeFileSync(homeIn(), 'not a directory');

    expect(hasGreeted(homeIn())).toBe(true);
  });

  it('counts a folder, or anything else that is not ours, in the marker place as greeted', () => {
    mkdirSync(greetedFileIn(homeIn()), { recursive: true });

    expect(hasGreeted(homeIn())).toBe(true);
  });

  it.skipIf(isWindows)('counts a link in the marker place as greeted, dangling or not', () => {
    mkdirSync(homeIn());
    symlinkSync(join(scratch, 'nowhere'), greetedFileIn(homeIn()));

    expect(hasGreeted(homeIn())).toBe(true);
  });
});

describe('markGreeted', () => {
  it('creates an empty file with mode 0600', () => {
    mkdirSync(homeIn());

    const written = markGreeted(homeIn());

    expect(written).toBe(true);
    const stat = lstatSync(greetedFileIn(homeIn()));
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBe(0);
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
  });

  it.skipIf(isWindows)('makes a home that is not there yet, with mode 0700', () => {
    const written = markGreeted(join(homeIn(), 'deeper'));

    expect(written).toBe(true);
    expect(lstatSync(homeIn()).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(homeIn(), 'deeper')).mode & 0o777).toBe(0o700);
  });

  it.skipIf(isWindows)('leaves the mode of a home that is there alone', () => {
    mkdirSync(homeIn(), { mode: 0o700 });
    chmodSync(homeIn(), 0o700);

    markGreeted(homeIn());

    expect(lstatSync(homeIn()).mode & 0o777).toBe(0o700);
  });

  it('is done once: a second call finds the marker and writes nothing', () => {
    mkdirSync(homeIn());
    expect(markGreeted(homeIn())).toBe(true);

    expect(markGreeted(homeIn())).toBe(false);
    expect(hasGreeted(homeIn())).toBe(true);
  });

  it('does not touch what is in the marker place already', () => {
    mkdirSync(homeIn());
    writeFileSync(greetedFileIn(homeIn()), 'kept');

    expect(markGreeted(homeIn())).toBe(false);

    expect(readFileSync(greetedFileIn(homeIn()), 'utf8')).toBe('kept');
  });

  it.skipIf(isWindows)(
    'does not write through a link to a file: the file keeps what it had',
    () => {
      mkdirSync(homeIn());
      const victim = join(scratch, 'victim.txt');
      writeFileSync(victim, 'precious');
      symlinkSync(victim, greetedFileIn(homeIn()));

      const written = markGreeted(homeIn());

      expect(written).toBe(false);
      expect(readFileSync(victim, 'utf8')).toBe('precious');
      expect(lstatSync(greetedFileIn(homeIn())).isSymbolicLink()).toBe(true);
      expect(hasGreeted(homeIn())).toBe(true);
    },
  );

  it.skipIf(isWindows)('does not make the file a dangling link points to', () => {
    mkdirSync(homeIn());
    const target = join(scratch, 'created-by-the-attacker');
    symlinkSync(target, greetedFileIn(homeIn()));

    expect(markGreeted(homeIn())).toBe(false);

    expect(existsSync(target)).toBe(false);
  });

  it('does not throw, and says it did not write, when the home cannot be made', () => {
    writeFileSync(homeIn(), 'a file where the home should be');

    expect(() => markGreeted(homeIn())).not.toThrow();
    expect(markGreeted(homeIn())).toBe(false);
    expect(readFileSync(homeIn(), 'utf8')).toBe('a file where the home should be');
  });

  it.skipIf(isWindows || process.getuid?.() === 0)(
    'does not throw, and says it did not write, when the home cannot be written to',
    () => {
      mkdirSync(homeIn(), { mode: 0o500 });
      chmodSync(homeIn(), 0o500);
      try {
        expect(() => markGreeted(homeIn())).not.toThrow();
        expect(markGreeted(homeIn())).toBe(false);
        expect(existsSync(greetedFileIn(homeIn()))).toBe(false);
      } finally {
        chmodSync(homeIn(), 0o700);
      }
    },
  );
});
