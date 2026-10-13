import { describe, expect, it } from 'vitest';
import { passportOf } from '../../helpers/inspect.js';

const nativeFiles = (passport: ReturnType<typeof passportOf>): string[] =>
  passport.signals.filter((signal) => signal.ruleId === 'native-code').map((signal) => signal.file);

const ELF = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0]);
const MACHO = Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]);
const MACHO_32 = Uint8Array.from([0xfe, 0xed, 0xfa, 0xce, 0, 0, 0, 1]);
const MACHO_FAT = Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]);
const PE = Uint8Array.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]);

describe('native code', () => {
  it('flags a binding.gyp and a .node file, and says they were not looked at', () => {
    const passport = passportOf(
      { 'binding.gyp': '{"targets": []}', 'build/addon.node': { bytes: ELF } },
      { kind: 'mcp' },
    );

    expect(nativeFiles(passport)).toEqual(['binding.gyp', 'build/addon.node']);
    expect(
      passport.blindSpots.some((spot) =>
        spot.startsWith('2 files of native code were not looked at'),
      ),
    ).toBe(true);
  });

  it.each([
    ['an ELF program', ELF],
    ['a Mach-O program', MACHO],
    ['a 32-bit Mach-O program', MACHO_32],
    ['a universal Mach-O program', MACHO_FAT],
    ['a Windows program', PE],
  ])('flags %s by its first bytes, whatever it is called', (_what, bytes) => {
    const passport = passportOf({ 'tools/not-a-script.dat': { bytes } });

    expect(nativeFiles(passport)).toEqual(['tools/not-a-script.dat']);
  });

  it('makes the signal sensitive and says what it rests on', () => {
    const passport = passportOf({ 'bin/run': { bytes: ELF, exec: true } });

    const line = passport.lines.find((candidate) => candidate.kind === 'signal');
    expect(line).toMatchObject({ subject: 'native-code', sensitive: true, basis: 'observed' });
    expect(line?.detector).toContain('not a verdict');
  });

  it('does not flag a text file that begins with the letters MZ, or a short file', () => {
    const passport = passportOf({
      'notes.txt': 'MZ is a magic number',
      'tiny.bin': { bytes: Uint8Array.from([0x7f]) },
      'cafe.txt': { bytes: Uint8Array.from([0xca, 0xfe, 0xba, 0xbe]) },
    });

    expect(nativeFiles(passport)).toEqual(['cafe.txt']);
  });

  it('flags a binding.gyp in a folder as well as at the root', () => {
    const passport = passportOf({ 'native/binding.gyp': '{}' });

    expect(nativeFiles(passport)).toEqual(['native/binding.gyp']);
  });

  it('says nothing of native code where there is none', () => {
    const passport = passportOf({ 'SKILL.md': '# s\n', 'lib/a.js': 'x = 1\n' });

    expect(nativeFiles(passport)).toEqual([]);
    expect(passport.blindSpots.some((spot) => spot.includes('native code'))).toBe(false);
  });
});
