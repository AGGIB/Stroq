import {
  inspectTree,
  type InspectContext,
  type InspectOverrides,
} from '../../src/install/inspect/index.js';
import { buildTree } from '../../src/install/tree.js';
import {
  PassportSchema,
  type CapKind,
  type Passport,
  type PassportLine,
} from '../../src/install/types.js';
import { entriesOf, type EntrySpec } from './install-tree.js';

/** The context every test inspects with, unless it says otherwise. The kind is given, so that a test of one reader does not depend on the detection of the kind. */
export const CONTEXT: InspectContext = {
  kind: 'skill',
  source: { type: 'dir', label: 'fixture' },
  extraBlindSpots: [],
  stroqVersion: '0.0.0-test',
  rulesId: 'test-rules/1',
};

export type Files = Readonly<Record<string, EntrySpec>>;

/** The tree of a spec, built as a reader builds it. */
export const completeTree = (files: Files) => buildTree(entriesOf(files), { complete: true });

/** The passport of a spec of files; every result is parsed through the schema, so a passport that does not fit it fails here. */
export function passportOf(files: Files, overrides: InspectOverrides = {}): Passport {
  const passport = inspectTree(completeTree(files), { ...CONTEXT, ...overrides });
  return PassportSchema.parse(passport);
}

export const linesOf = (passport: Passport, kind: CapKind): readonly PassportLine[] =>
  passport.lines.filter((line) => line.kind === kind);

export const subjectsOf = (passport: Passport, kind: CapKind): readonly string[] =>
  linesOf(passport, kind).map((line) => line.subject);

export const lineOf = (
  passport: Passport,
  kind: CapKind,
  subject: string,
): PassportLine | undefined =>
  passport.lines.find((line) => line.kind === kind && line.subject === subject);

/** A skill file with the front matter given, which most readers of the front matter are tested with. */
export const skillWith = (frontMatter: string, body = '# Skill\n'): string =>
  `---\n${frontMatter}\n---\n${body}`;
