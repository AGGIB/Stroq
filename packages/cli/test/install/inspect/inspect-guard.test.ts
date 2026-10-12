import { describe, expect, it, vi } from 'vitest';
import { lineOf, passportOf } from '../../helpers/inspect.js';

// One reading is made to fail, as a bug or a text nobody thought of could make it. The passport must
// still be made, must still hold what the other readings found, and must say that one reading is missing.
vi.mock('../../../src/install/inspect/native-code.js', () => ({
  inspectNativeCode: () => {
    throw new RangeError('Maximum call stack size exceeded');
  },
}));
vi.mock('../../../src/install/inspect/obfuscation.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../src/install/inspect/obfuscation.js')>();
  return {
    ...original,
    obfuscationReasons: () => {
      throw new Error('boom');
    },
  };
});

describe('a reading that fails', () => {
  const passport = passportOf({
    'SKILL.md': '---\nname: still-named\nallowed-tools: WebFetch\n---\n# s\n',
    'lib/a.js': 'const k = process.env.STILL_FOUND_KEY;\n',
    'bin/prog': { bytes: Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]) },
  });

  it('does not stop the passport, or the readings that did not fail', () => {
    expect(passport.artifact.name).toBe('still-named');
    expect(lineOf(passport, 'allowed-tools', 'WebFetch')).toBeDefined();
    expect(lineOf(passport, 'cred.env', 'STILL_FOUND_KEY')).toBeDefined();
  });

  it('says that readings failed and that what they read is missing, and counts them', () => {
    expect(passport.blindSpots).toContain(
      '2 readings failed on this tree, and what they read is missing from this passport',
    );
  });

  it('does not claim what the failed reading would have found', () => {
    expect(passport.signals.filter((signal) => signal.ruleId === 'native-code')).toEqual([]);
  });
});
