// Native code in a tree: a build file for one, a Node addon, or a compiled program.
//
// None of it can be read by a reading of text, so it is a signal and a blind spot: what it does is
// not known. A compiled program is recognised by the first bytes of the file whatever the file is
// called, because a name is the one thing an author chooses freely.
import type { Findings } from './findings.js';
import type { InspectInput } from './input.js';

const DETECTOR =
  'native code (a compiled program, a Node addon or a build file for one) that a reading of text cannot read; a signal to look at, not a verdict';

/** The first bytes of the programs of the three systems; each is the magic number of its format. */
const MAGIC: readonly (readonly number[])[] = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O, 64-bit
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O, 32-bit
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O, 64-bit, the other byte order
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O, 32-bit, the other byte order
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O universal, and a Java class file
];
/** A Windows program begins with the letters MZ, which text may too; its header has zero bytes close behind. */
const PE_HEADER_ZEROS_WITHIN = 64;

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return bytes.byteLength >= magic.length && magic.every((byte, at) => bytes[at] === byte);
}

function isCompiled(bytes: Uint8Array): boolean {
  if (MAGIC.some((magic) => startsWith(bytes, magic))) return true;
  return startsWith(bytes, [0x4d, 0x5a]) && bytes.subarray(0, PE_HEADER_ZEROS_WITHIN).includes(0);
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export function inspectNativeCode(input: InspectInput, findings: Findings): void {
  for (const entry of input.tree.entries) {
    if (entry.kind !== 'file') continue;
    const name = basename(entry.path);
    const native =
      name === 'binding.gyp' ||
      name.toLowerCase().endsWith('.node') ||
      (entry.bytes !== undefined && isCompiled(entry.bytes));
    if (!native) continue;
    findings.tally('native-code');
    findings.signal({
      ruleId: 'native-code',
      file: entry.path,
      line: null,
      sensitive: true,
      detector: DETECTOR,
    });
  }
}
