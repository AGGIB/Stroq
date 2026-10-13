import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { formatAge, readHookStamp, stampHookFired } from '../src/hook-stamp.js';
import { logFile } from '../src/paths.js';

/**
 * A firewall that does nothing is the worst way for one to fail, and `doctor` read only
 * configuration: a hook entry the host no longer runs (hooks switched off, an approval that no
 * longer matches, a plugin that never loaded) looked exactly like one that is. The stamp is the
 * evidence that the host really called Stroq: when, per agent, and nothing else.
 */
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stroq-stamp-'));
  process.env['STROQ_HOME'] = home;
});

describe('the hook stamp', () => {
  it('writes the time of the call under the home, one file for each agent', () => {
    stampHookFired('claude-code', new Date('2026-10-06T10:00:00.000Z'));
    stampHookFired('codex', new Date('2026-10-06T10:05:00.000Z'));
    expect(readFileSync(join(home, 'last-hook', 'claude-code'), 'utf8')).toBe(
      '2026-10-06T10:00:00.000Z\n',
    );
    expect(readFileSync(join(home, 'last-hook', 'codex'), 'utf8')).toBe(
      '2026-10-06T10:05:00.000Z\n',
    );
  });

  it('holds the time and nothing else', () => {
    stampHookFired('cursor', new Date('2026-10-06T10:00:00.000Z'));
    expect(readFileSync(join(home, 'last-hook', 'cursor'), 'utf8').trim()).toMatch(
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/,
    );
  });

  it('is read back as that time', () => {
    stampHookFired('claude-code', new Date('2026-10-06T10:00:00.000Z'));
    expect(readHookStamp('claude-code')?.toISOString()).toBe('2026-10-06T10:00:00.000Z');
  });

  it('keeps the latest call', () => {
    stampHookFired('claude-code', new Date('2026-10-06T10:00:00.000Z'));
    stampHookFired('claude-code', new Date('2026-10-06T11:30:00.000Z'));
    expect(readHookStamp('claude-code')?.toISOString()).toBe('2026-10-06T11:30:00.000Z');
  });

  it('says there is no record for an agent that has not called', () => {
    expect(readHookStamp('windsurf')).toBeNull();
  });

  // Only what `stampHookFired` writes is a record. `Date.parse` is lenient: it takes "1" for 2001,
  // a US date, and a time with no zone for the reader's own, which is hours off.
  it.each([
    '',
    'garbage',
    '2026-13-45T99:99:99Z',
    '{"a":1}',
    '1',
    '10/06/2026',
    'Oct 6 2026 10:00:00 UTC',
    '2026-10-06T10:00:00.000',
    '2026-10-06T10:00:00Z',
    '2026-10-06T10:00:00.000+05:00',
    '2026-02-31T00:00:00.000Z',
    '2026-10-06T10:00:00.000Z and more',
    `2026-10-06T10:00:00.000Z${' '.repeat(200)}x`,
  ])('takes a file that does not hold exactly a time (%j) for no record', (text) => {
    stampHookFired('claude-code');
    writeFileSync(join(home, 'last-hook', 'claude-code'), text);
    expect(readHookStamp('claude-code')).toBeNull();
  });

  it('takes a long file for no record', () => {
    stampHookFired('claude-code');
    writeFileSync(join(home, 'last-hook', 'claude-code'), 'x'.repeat(5_000_000));
    expect(readHookStamp('claude-code')).toBeNull();
  });

  it('takes a directory where the stamp should be for no record', () => {
    mkdirSync(join(home, 'last-hook', 'claude-code'), { recursive: true });
    expect(readHookStamp('claude-code')).toBeNull();
    expect(() => stampHookFired('claude-code')).not.toThrow();
  });

  // A hook that cannot leave a mark must still answer: the stamp is not worth a decision.
  it('never throws, whatever stands where it is written', () => {
    const notADirectory = join(home, 'a-file');
    writeFileSync(notADirectory, 'x');
    process.env['STROQ_HOME'] = notADirectory;
    expect(() => stampHookFired('claude-code')).not.toThrow();
    expect(readHookStamp('claude-code')).toBeNull();
  });

  // Doctor's "no hook call recorded" reads as the host's fault, so a failed write says its own.
  it('says in the log why it could not leave a mark, in one line', () => {
    writeFileSync(join(home, 'last-hook'), 'x');
    stampHookFired('claude-code');
    const lines = readFileSync(logFile(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/ hook stamp: /);
  });

  it('writes nothing to the log when the mark is left', () => {
    stampHookFired('claude-code');
    expect(existsSync(logFile())).toBe(false);
  });

  it('never reads outside its directory, whatever the agent is called', () => {
    stampHookFired('../escape', new Date('2026-10-06T10:00:00.000Z'));
    expect(existsSync(join(home, 'escape'))).toBe(false);
    expect(readHookStamp('../escape')).toBeNull();
  });

  describe.skipIf(process.platform === 'win32')('where the file system has more to say', () => {
    // A link where the stamp goes, planted by anything that could write under the home, made this
    // write follow it: the next hook call replaced the target with a time.
    it('does not write through a link planted where the stamp goes', () => {
      const victim = join(home, 'precious');
      writeFileSync(victim, 'PRECIOUS\n');
      mkdirSync(join(home, 'last-hook'), { recursive: true });
      symlinkSync(victim, join(home, 'last-hook', 'claude-code'));
      expect(() => stampHookFired('claude-code')).not.toThrow();
      expect(readFileSync(victim, 'utf8')).toBe('PRECIOUS\n');
    });

    it('does not write through a link that points nowhere either', () => {
      const target = join(home, 'not-there');
      mkdirSync(join(home, 'last-hook'), { recursive: true });
      symlinkSync(target, join(home, 'last-hook', 'claude-code'));
      stampHookFired('claude-code');
      expect(existsSync(target)).toBe(false);
    });

    it('still works when the home itself is a link, as a dotfile manager leaves it', () => {
      const real = mkdtempSync(join(tmpdir(), 'stroq-stamp-real-'));
      const link = join(home, 'linked-home');
      symlinkSync(real, link);
      process.env['STROQ_HOME'] = link;
      stampHookFired('claude-code', new Date('2026-10-06T10:00:00.000Z'));
      expect(readFileSync(join(real, 'last-hook', 'claude-code'), 'utf8')).toBe(
        '2026-10-06T10:00:00.000Z\n',
      );
    });

    // `process.umask(0)` so that the modes asked for are the modes seen: under a strict umask the
    // file is private whatever is asked, and the test would pass with the options deleted.
    it('is private to its owner', () => {
      const previous = process.umask(0);
      try {
        stampHookFired('claude-code');
      } finally {
        process.umask(previous);
      }
      expect(statSync(join(home, 'last-hook')).mode & 0o777).toBe(0o700);
      expect(statSync(join(home, 'last-hook', 'claude-code')).mode & 0o777).toBe(0o600);
    });
  });
});

describe('formatAge', () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it.each([
    [0, 'just now'],
    [59_000, 'just now'],
    [MINUTE, '1 min ago'],
    [3 * MINUTE + 20_000, '3 min ago'],
    [59 * MINUTE, '59 min ago'],
    [HOUR, '1 h ago'],
    [5 * HOUR + 40 * MINUTE, '5 h ago'],
    [47 * HOUR, '47 h ago'],
    [48 * HOUR - 1, '47 h ago'],
    [48 * HOUR, '2 days ago'],
    [2 * DAY, '2 days ago'],
    [10 * DAY + 3 * HOUR, '10 days ago'],
  ])('%d ms is %s', (ms, text) => {
    expect(formatAge(ms)).toBe(text);
  });

  // A stamp a moment ahead of `now`; how far ahead is too far is for `doctor` to say.
  it('does not say a negative age', () => {
    expect(formatAge(-5 * MINUTE)).toBe('just now');
  });
});
