import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ARTIFACT_KINDS,
  BASES,
  CAP_KINDS,
  ImportedFindingSchema,
  LIMITS,
  PASSPORT_SCHEMA,
  PassportLineSchema,
  PassportSchema,
  type Basis,
  type CapKind,
  type ImportedFinding,
  type Passport,
  type PassportLine,
  type SourceRef,
  type Tree,
  type TreeEntry,
} from '../../src/install/types.js';

const DIGEST = '40d01f91f80f781704e8e0b4945c1ee67cce432b5356ab57d8c7819febf50b7a';

/** A passport that is valid in every part, written as a lock file would hold it: plain JSON. */
const VALID = {
  schema: 'stroq-passport/1',
  artifact: {
    kind: 'skill',
    name: 'demo',
    version: null,
    source: { type: 'github', owner: 'acme', repo: 'demo', ref: 'main', subdir: 'skills/demo' },
    digest: DIGEST,
    files: 2,
    bytes: 120,
  },
  lines: [
    {
      kind: 'net',
      subject: 'api.example.com',
      basis: 'declared',
      sensitive: true,
      where: [{ file: 'SKILL.md', line: 12 }],
      detector: 'frontmatter',
    },
    {
      kind: 'cred.env',
      subject: 'API_TOKEN',
      basis: 'unknown',
      sensitive: true,
      where: [{ file: 'scripts/run.sh', line: null }],
      detector: 'shell-script',
    },
  ],
  blindSpots: ['scripts/native.node is a binary file and was not read'],
  signals: [{ ruleId: 'atr-0042', file: 'SKILL.md' }],
  imported: [
    {
      tool: 'scanner-x',
      id: 'X-1',
      severity: 'high',
      title: 'Hidden instruction',
      path: 'SKILL.md',
      line: 3,
    },
  ],
  analysis: { stroq: '0.23.0', rules: 'bundle-1' },
};

const line = (patch: Record<string, unknown>) => ({
  ...VALID,
  lines: [{ ...VALID.lines[0], ...patch }],
});
const artifact = (patch: Record<string, unknown>) => ({
  ...VALID,
  artifact: { ...VALID.artifact, ...patch },
});
const source = (value: unknown) => artifact({ source: value });

describe('LIMITS', () => {
  it('are the limits of the design', () => {
    expect(LIMITS).toEqual({
      maxCompressed: 20 * 1024 * 1024,
      maxExpanded: 32 * 1024 * 1024,
      maxEntries: 5000,
      maxPathBytes: 240,
      maxDepth: 20,
      maxFileBytes: 8 * 1024 * 1024,
      perRequestMs: 20_000,
      totalMs: 60_000,
    });
  });

  it('cannot be changed by whoever imports them', () => {
    expect(Object.isFrozen(LIMITS)).toBe(true);
    expect(() => {
      (LIMITS as { maxEntries: number }).maxEntries = 1;
    }).toThrow(TypeError);
  });
});

describe('the words of a passport', () => {
  it('has the four bases, from the weakest claim to none', () => {
    expect(BASES).toEqual(['declared', 'observed', 'limited', 'unknown']);
  });

  it('has the kinds of line the design lists, and no others', () => {
    expect(CAP_KINDS).toEqual([
      'fs.read',
      'fs.write',
      'net',
      'cred.env',
      'cred.file',
      'exec',
      'hook',
      'install-script',
      'tool',
      'allowed-tools',
      'signal',
    ]);
  });

  it('has the three kinds of artifact', () => {
    expect(ARTIFACT_KINDS).toEqual(['skill', 'mcp', 'plugin']);
  });

  it('names its own format', () => {
    expect(PASSPORT_SCHEMA).toBe('stroq-passport/1');
  });
});

describe('PassportSchema', () => {
  describe('accepts', () => {
    it('a valid passport, and gives back what it was given', () => {
      expect(PassportSchema.parse(VALID)).toEqual(VALID);
    });

    it('a passport that went through JSON, as a lock file is read back', () => {
      const parsed = PassportSchema.parse(VALID);

      expect(PassportSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    });

    it('a passport with nothing found: no lines, no blind spots, no signals, nothing imported', () => {
      const empty = { ...VALID, lines: [], blindSpots: [], signals: [], imported: [] };

      expect(PassportSchema.safeParse(empty).success).toBe(true);
    });

    it('a line that has no place in any file', () => {
      expect(PassportSchema.safeParse(line({ where: [] })).success).toBe(true);
    });

    it.each([...BASES])('the basis %s', (basis) => {
      expect(PassportSchema.safeParse(line({ basis })).success).toBe(true);
    });

    it.each([...CAP_KINDS])('the kind of line %s', (kind) => {
      expect(PassportSchema.safeParse(line({ kind })).success).toBe(true);
    });

    it.each([...ARTIFACT_KINDS])('the kind of artifact %s', (kind) => {
      expect(PassportSchema.safeParse(artifact({ kind })).success).toBe(true);
    });

    it('a version', () => {
      expect(PassportSchema.safeParse(artifact({ version: '1.2.3' })).success).toBe(true);
    });

    it('an imported finding that has no place', () => {
      const minimal = { tool: 't', id: 'i', severity: 'low', title: 'x' };

      expect(PassportSchema.safeParse({ ...VALID, imported: [minimal] }).success).toBe(true);
    });
  });

  describe('rejects', () => {
    it('a basis it does not know', () => {
      expect(PassportSchema.safeParse(line({ basis: 'verified' })).success).toBe(false);
      expect(PassportSchema.safeParse(line({ basis: 'Declared' })).success).toBe(false);
      expect(PassportSchema.safeParse(line({ basis: '' })).success).toBe(false);
    });

    it('a kind of line it does not know', () => {
      expect(PassportSchema.safeParse(line({ kind: 'fs.delete' })).success).toBe(false);
    });

    it('a kind of artifact it does not know', () => {
      expect(PassportSchema.safeParse(artifact({ kind: 'extension' })).success).toBe(false);
    });

    it.each([
      ['at the top', { ...VALID, extra: 1 }],
      ['in the artifact', artifact({ extra: 1 })],
      ['in a line', line({ extra: 1 })],
      ['in the place of a line', line({ where: [{ file: 'a', line: 1, extra: 1 }] })],
      ['in a signal', { ...VALID, signals: [{ ruleId: 'r', file: 'a', extra: 1 }] }],
      [
        'in an imported finding',
        { ...VALID, imported: [{ tool: 't', id: 'i', severity: 's', title: 'x', extra: 1 }] },
      ],
      ['in the analysis', { ...VALID, analysis: { stroq: '1', rules: 'r', extra: 1 } }],
      ['in the source', source({ type: 'dir', label: 'x', extra: 1 })],
    ])('a key it does not know, %s', (_where, value) => {
      expect(PassportSchema.safeParse(value).success).toBe(false);
    });

    it.each(Object.keys(VALID))('a passport without its %s', (key) => {
      const { [key as keyof typeof VALID]: _removed, ...rest } = VALID;

      expect(PassportSchema.safeParse(rest).success).toBe(false);
    });

    it.each([
      ['another version of the format', { ...VALID, schema: 'stroq-passport/2' }],
      ['no format', { ...VALID, schema: undefined }],
      ['a digest in capitals', artifact({ digest: DIGEST.toUpperCase() })],
      ['a digest with the algorithm in front', artifact({ digest: `sha256:${DIGEST}` })],
      ['a digest that is too short', artifact({ digest: DIGEST.slice(0, 32) })],
      ['an empty name', artifact({ name: '' })],
      ['an empty version', artifact({ version: '' })],
      ['a negative number of files', artifact({ files: -1 })],
      ['a fractional number of bytes', artifact({ bytes: 1.5 })],
      ['a number of files that is text', artifact({ files: '2' })],
      ['a line number of zero', line({ where: [{ file: 'a', line: 0 }] })],
      ['a fractional line number', line({ where: [{ file: 'a', line: 1.5 }] })],
      ['a line in no file', line({ where: [{ file: '', line: 1 }] })],
      ['a line with no subject', line({ subject: '' })],
      ['a line with no detector', line({ detector: '' })],
      ['a sensitive flag that is not a boolean', line({ sensitive: 'yes' })],
      ['a signal with no rule', { ...VALID, signals: [{ ruleId: '', file: 'a' }] }],
      ['a blind spot that is not text', { ...VALID, blindSpots: [3] }],
      ['an empty blind spot', { ...VALID, blindSpots: [''] }],
      [
        'an imported finding with a line of zero',
        { ...VALID, imported: [{ tool: 't', id: 'i', severity: 's', title: 'x', line: 0 }] },
      ],
      ['an analysis with no rules', { ...VALID, analysis: { stroq: '1' } }],
    ])('%s', (_what, value) => {
      expect(PassportSchema.safeParse(value).success).toBe(false);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['text', 'passport'],
      ['a number', 42],
      ['an empty list', []],
      ['a list of passports', [VALID]],
    ])('%s, which is not a passport', (_what, value) => {
      expect(PassportSchema.safeParse(value).success).toBe(false);
    });

    // `__proto__` in JSON is an ordinary key; here it is an extra one, and is refused like any other.
    it('a key that tries to reach the prototype', () => {
      const hostile = JSON.parse(
        `{"__proto__":{"polluted":true},${JSON.stringify(VALID).slice(1)}`,
      );

      expect(PassportSchema.safeParse(hostile).success).toBe(false);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });
  });

  it('gives back a passport that nothing can change', () => {
    const parsed = PassportSchema.parse(VALID);

    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.artifact)).toBe(true);
    expect(Object.isFrozen(parsed.artifact.source)).toBe(true);
    expect(Object.isFrozen(parsed.lines)).toBe(true);
    expect(Object.isFrozen(parsed.lines[0])).toBe(true);
    expect(Object.isFrozen(parsed.lines[0]?.where)).toBe(true);
    expect(Object.isFrozen(parsed.analysis)).toBe(true);
  });

  it('does not freeze, or otherwise touch, what it was given', () => {
    PassportSchema.parse(VALID);

    expect(Object.isFrozen(VALID)).toBe(false);
    expect(Object.isFrozen(VALID.lines)).toBe(false);
  });
});

describe('PassportLineSchema and ImportedFindingSchema', () => {
  it('are the schemas of the parts, for whoever builds only that part', () => {
    expect(PassportLineSchema.safeParse(VALID.lines[0]).success).toBe(true);
    expect(PassportLineSchema.safeParse({ ...VALID.lines[0], basis: 'x' }).success).toBe(false);
    expect(ImportedFindingSchema.safeParse(VALID.imported[0]).success).toBe(true);
    expect(ImportedFindingSchema.safeParse({ ...VALID.imported[0], severity: '' }).success).toBe(
      false,
    );
  });
});

describe('the types', () => {
  it('are readonly all the way down, and agree with the words above', () => {
    expectTypeOf<Passport['schema']>().toEqualTypeOf<'stroq-passport/1'>();
    expectTypeOf<Passport['lines']>().toEqualTypeOf<readonly PassportLine[]>();
    expectTypeOf<Passport['blindSpots']>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<Passport['imported']>().toEqualTypeOf<readonly ImportedFinding[]>();
    expectTypeOf<Passport['artifact']['source']>().toEqualTypeOf<SourceRef>();
    expectTypeOf<Passport['artifact']['version']>().toEqualTypeOf<string | null>();
    expectTypeOf<PassportLine['basis']>().toEqualTypeOf<Basis>();
    expectTypeOf<PassportLine['kind']>().toEqualTypeOf<CapKind>();
    expectTypeOf<PassportLine['where'][number]['line']>().toEqualTypeOf<number | null>();
    expectTypeOf<Tree['entries']>().toEqualTypeOf<readonly TreeEntry[]>();
    expectTypeOf<TreeEntry['kind']>().toEqualTypeOf<'file' | 'symlink' | 'gitlink'>();
    expectTypeOf<TreeEntry['bytes']>().toEqualTypeOf<Uint8Array | undefined>();
  });

  // Never called: the point is that this does not compile if a field can be written to, which the
  // type-check of the test folder (`pnpm typecheck`) is what reports.
  it('do not let a field be changed', () => {
    function mustNotCompile(entry: TreeEntry, found: PassportLine, passport: Passport): void {
      // @ts-expect-error a tree entry is read-only
      entry.size = 1;
      // @ts-expect-error a passport line is read-only
      found.subject = 'x';
      // @ts-expect-error the list of lines is read-only
      passport.lines.push(found);
    }

    expect(mustNotCompile).toBeTypeOf('function');
  });

  it('treat an optional key as absent and not as undefined, as the schema does', () => {
    const present: SourceRef = { type: 'npm', name: 'p', version: '1', integrity: 'sha512-x' };
    const absent: SourceRef = { type: 'npm', name: 'p', version: '1' };
    // @ts-expect-error `integrity: undefined` is not the same as no `integrity`
    const explicit: SourceRef = { type: 'npm', name: 'p', version: '1', integrity: undefined };

    expect([present, absent, explicit]).toHaveLength(3);
  });
});
