import { PassportSchema, type CapKind, type Passport } from '../../src/install/types.js';

/**
 * The screen of `stroq vet` and its card, from a passport and nothing else: no disk, no reader. A passport
 * is built here line by line so that each rule of the screen has a case of its own.
 */
export type Spec = {
  readonly kind?: CapKind;
  readonly subject: string;
  readonly sensitive?: boolean;
  readonly basis?: 'declared' | 'observed' | 'limited' | 'unknown';
  readonly where?: readonly { file: string; line: number | null }[];
};

export const BLIND = [
  'anything the program fetches, builds or decides at run time was not looked at',
  'code in languages other than JavaScript, TypeScript, Python and shell was not read',
  'nothing was run: this is a reading of the files, and what the program does when it runs was not observed',
];
export const DIGEST = 'c'.repeat(64);

export function passportWith(
  specs: readonly Spec[],
  rest: {
    readonly name?: string;
    readonly version?: string | null;
    readonly blindSpots?: readonly string[];
    readonly signals?: readonly { ruleId: string; file: string }[];
    readonly kind?: 'skill' | 'mcp' | 'plugin';
    readonly files?: number;
    readonly bytes?: number;
  } = {},
): Passport {
  return PassportSchema.parse({
    schema: 'stroq-passport/1',
    artifact: {
      kind: rest.kind ?? 'skill',
      name: rest.name ?? 'demo',
      version: rest.version ?? null,
      source: { type: 'dir', label: 'demo-folder' },
      digest: DIGEST,
      files: rest.files ?? 3,
      bytes: rest.bytes ?? 1200,
    },
    lines: specs.map((spec) => ({
      kind: spec.kind ?? 'exec',
      subject: spec.subject,
      basis: spec.basis ?? 'observed',
      sensitive: spec.sensitive ?? false,
      where: spec.where ?? [{ file: 'SKILL.md', line: 3 }],
      detector: 'a detector phrase that the screen does not print',
    })),
    blindSpots: rest.blindSpots ?? BLIND,
    signals: rest.signals ?? [],
    imported: [],
    analysis: { stroq: '0.0.0-test', rules: 'test-rules/1' },
  });
}

export const many = <T>(count: number, make: (index: number) => T): T[] =>
  Array.from({ length: count }, (_, index) => make(index));
