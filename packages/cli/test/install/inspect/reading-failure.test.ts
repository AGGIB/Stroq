import { describe, expect, it } from 'vitest';
import {
  failedReadings,
  inspectTree,
  inspectWithReadings,
  passportIsIncomplete,
  READINGS,
  READING_NAMES,
  type NamedReading,
} from '../../../src/install/inspect/index.js';
import { PassportSchema, type Passport } from '../../../src/install/types.js';
import { CONTEXT, completeTree, lineOf, passportOf } from '../../helpers/inspect.js';

/**
 * A passport that is made while a reading has failed lacks what that reading finds, and a hostile
 * artifact that could make one reading fail would hide a use from the passport if the failure were a
 * count in a list of blind spots. So a failure is a sensitive signal that names the reading, a blind
 * spot that names it, and a fact the next tool can ask (`passportIsIncomplete`): it must not treat a
 * passport like that as a complete one, and so must not confirm it.
 */
const FILES = {
  'SKILL.md': '---\nname: still-named\nallowed-tools: WebFetch\n---\n# s\n',
  'lib/a.js': 'const k = process.env.STILL_FOUND_KEY;\n',
  'package.json': JSON.stringify({ name: 'x', scripts: { postinstall: 'node a.js' } }),
};

/** The readings of the tree, with the one called `name` made to fail the way an exception in it would. */
function failing(...names: string[]): readonly NamedReading[] {
  return READINGS.map((reading) =>
    names.includes(reading.name)
      ? {
          name: reading.name,
          run: () => {
            throw new RangeError(
              'Maximum call stack size exceeded: file-name-from-the-artifact.js',
            );
          },
        }
      : reading,
  );
}

const withFailing = (...names: string[]): Passport =>
  PassportSchema.parse(inspectWithReadings(completeTree(FILES), CONTEXT, failing(...names)));

describe('the names of the readings', () => {
  it('are fixed words, and every reading of the passport has one', () => {
    expect(READINGS.map((reading) => reading.name).sort()).toEqual([...READING_NAMES].sort());
    for (const name of READING_NAMES) expect(name).toMatch(/^[a-z][a-z-]*$/);
  });
});

describe.each(READING_NAMES)('the reading %s fails', (name) => {
  const passport = withFailing(name);

  it('still gives a passport that fits the schema', () => {
    expect(PassportSchema.safeParse(passport).success).toBe(true);
  });

  it('adds a sensitive signal that names the reading and no text of the artifact', () => {
    expect(passport.signals).toContainEqual({ ruleId: `reading-failed:${name}`, file: '.' });
    expect(lineOf(passport, 'signal', `reading-failed:${name}`)).toMatchObject({
      sensitive: true,
      basis: 'unknown',
      where: [{ file: '.', line: null }],
    });
  });

  it('adds a blind spot that names the reading and says what is missing', () => {
    const spot = passport.blindSpots.find((text) => text.includes(`"${name}"`));

    expect(spot).toMatch(
      /^the reading "[a-z-]+" \(.+\) failed, and what it finds is missing from this passport$/,
    );
  });

  it('holds nothing of the exception or of the artifact in the signal or the blind spot', () => {
    const text = JSON.stringify([passport.signals, passport.blindSpots]);

    expect(text).not.toContain('Maximum call stack');
    expect(text).not.toContain('file-name-from-the-artifact');
  });

  it('is told by failedReadings and makes the passport incomplete', () => {
    expect(failedReadings(passport)).toEqual([name]);
    expect(passportIsIncomplete(passport)).toBe(true);
  });
});

describe('a passport without a failure', () => {
  const passport = passportOf(FILES);

  it('is complete as far as the readings go, and has no reading named as failed', () => {
    expect(failedReadings(passport)).toEqual([]);
    expect(passportIsIncomplete(passport)).toBe(false);
    expect(passport.blindSpots.some((spot) => spot.includes('failed'))).toBe(false);
  });

  it('is the same passport that inspectTree gives', () => {
    expect(inspectWithReadings(completeTree(FILES), CONTEXT, READINGS)).toEqual(
      inspectTree(completeTree(FILES), CONTEXT),
    );
  });
});

describe('a failure leaves the rest of the passport alone', () => {
  it('keeps what the readings that did not fail found', () => {
    const passport = withFailing('source');

    expect(lineOf(passport, 'allowed-tools', 'WebFetch')).toBeDefined();
    expect(lineOf(passport, 'install-script', 'postinstall: node a.js')).toBeDefined();
    expect(lineOf(passport, 'cred.env', 'STILL_FOUND_KEY')).toBeUndefined();
  });

  it('keeps the name the artifact is given when the front matter reading fails', () => {
    const passport = withFailing('frontmatter');

    expect(lineOf(passport, 'allowed-tools', 'WebFetch')).toBeUndefined();
    expect(passport.artifact.name).toBe('fixture');
  });

  it('names several failed readings, once each and in a fixed order, whatever the order they failed in', () => {
    const forward = withFailing('source', 'package-json', 'native-code');
    const backward = withFailing('native-code', 'package-json', 'source', 'source');

    expect(failedReadings(forward)).toEqual(['native-code', 'package-json', 'source']);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(backward));
    expect(forward.blindSpots.filter((spot) => spot.includes('failed'))).toHaveLength(3);
  });
});

describe('passportIsIncomplete', () => {
  it('reads the signals of the passport and not the text of its lines', () => {
    const base = passportOf({ 'SKILL.md': '# s\n' });
    const forged = {
      ...base,
      lines: [
        {
          kind: 'signal' as const,
          subject: 'reading-failed:source',
          basis: 'declared' as const,
          sensitive: false,
          where: [{ file: 'a', line: null }],
          detector: 'x',
        },
      ],
      blindSpots: [
        'the reading "source" (source files) failed, and what it finds is missing from this passport',
      ],
    };

    expect(failedReadings(forged)).toEqual([]);
    expect(passportIsIncomplete(forged)).toBe(false);
  });

  it('is true for a passport of another version that names a reading this one does not know', () => {
    const base = passportOf({ 'SKILL.md': '# s\n' });
    const other = { ...base, signals: [{ ruleId: 'reading-failed:future-reading', file: '.' }] };

    expect(failedReadings(other)).toEqual(['future-reading']);
    expect(passportIsIncomplete(other)).toBe(true);
  });
});
