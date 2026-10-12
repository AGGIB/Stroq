// What an artifact asks for or can do, read from its files alone: the passport of a tree.
//
// This is a reading and never a run. Nothing from the artifact is executed, nothing is fetched, and
// the only thing looked at is the tree in memory that a reader made and checked. The passport is a
// record of what was found, never a promise of what is not there: an absent line means nothing, the
// blind spots say what was not looked at, and every line says what it rests on (`basis`) and which
// reading found it (`detector`). The readings are signals to a person and never verdicts.
//
// The passport is canonical. The same tree, read by the same Stroq with the same rules, gives the
// same bytes: lines are joined and put in an order that looks only at what they say, and nothing of the
// time, the machine or the order of the reading is in it.
import { schemaFault } from '../schema-fault.js';
import { treeDigest, treeStats } from '../tree.js';
import {
  PASSPORT_SCHEMA,
  PassportSchema,
  type ArtifactKind,
  type Passport,
  type SourceRef,
  type Tree,
} from '../types.js';
import { detectKind } from './detect-kind.js';
import { Findings } from './findings.js';
import { identify } from './identity.js';
import { inspectFrontmatter } from './frontmatter-lines.js';
import { buildInput } from './input.js';
import { inspectNativeCode } from './native-code.js';
import { inspectPackages } from './package-lines.js';
import { inspectPython } from './python-lines.js';
import { ShellQueue } from './shell-queue.js';
import { addShellLines } from './shell-lines.js';
import { queueMarkdownShell, queueScriptShell } from './shell-sources.js';

export interface InspectContext {
  /** What kind of artifact it is, or `auto` to tell from the files (a kind that cannot be told is an error). */
  readonly kind: ArtifactKind | 'auto';
  /** Where it came from: a label, a package, a repository, a host. */
  readonly source: SourceRef;
  /** What the reader of the source did not look at (a `.git` folder left out, say). */
  readonly extraBlindSpots: readonly string[];
  /** The version of Stroq that makes the reading. */
  readonly stroqVersion: string;
  /** The rules the reading follows; another set of rules may read the same files differently. */
  readonly rulesId: string;
}

export type InspectOverrides = Partial<InspectContext>;

export type InspectErrorCode =
  /** The files do not say what kind of artifact this is, or say two. */
  | 'cannot-tell-kind'
  /** A file of the tree has no bytes, or a link no target: there is nothing to read. */
  | 'incomplete-tree'
  /** The passport made did not fit its schema: a fault in the source given, or in this code. */
  | 'invalid-passport';

/** Why a tree was not read. `message` is a fixed phrase and holds no text from the artifact. */
export class InspectError extends Error {
  readonly code: InspectErrorCode;

  constructor(code: InspectErrorCode, message: string) {
    super(message);
    this.name = 'InspectError';
    this.code = code;
  }
}

const CANNOT_TELL: Readonly<Record<'none' | 'more-than-one', string>> = {
  none: 'the files do not say what kind of artifact this is (a skill, an MCP server or a plugin); say which kind it is',
  'more-than-one':
    'the files look like more than one kind of artifact (a skill and an MCP server, say); say which kind it is',
};

/** A tree of claims alone has a digest and nothing to read, and an inspector that reads nothing says nothing. */
function assertComplete(tree: Tree): void {
  const missing = tree.entries.some(
    (entry) =>
      (entry.kind === 'file' && entry.bytes === undefined) ||
      (entry.kind === 'symlink' && entry.target === undefined),
  );
  if (missing) {
    throw new InspectError(
      'incomplete-tree',
      'the tree has a file without its bytes or a link without its target, so there is nothing to read',
    );
  }
}

/**
 * The passport of a tree. Throws a `TreeError` for a tree that is not valid (its digest is taken here,
 * which checks every size and hash against the bytes), and an `InspectError` for the faults above.
 */
export function inspectTree(tree: Tree, context: InspectContext): Passport {
  assertComplete(tree);
  const digest = treeDigest(tree);
  const findings = new Findings();
  for (const spot of context.extraBlindSpots) findings.blindSpot(spot);
  const input = buildInput(tree, findings);

  let kind: ArtifactKind;
  if (context.kind === 'auto') {
    const detected = detectKind(input);
    if ('problem' in detected)
      throw new InspectError('cannot-tell-kind', CANNOT_TELL[detected.problem]);
    kind = detected.kind;
  } else {
    kind = context.kind;
  }

  const shell = new ShellQueue();
  const declared = inspectFrontmatter(input, findings, shell);
  queueMarkdownShell(input, findings, shell);
  queueScriptShell(input, shell);
  inspectPackages(input, findings, shell);
  inspectPython(input, findings);
  inspectNativeCode(input, findings);
  addShellLines(shell, findings);

  const identity = identify(kind, input, context.source, declared);
  const found = findings.result();
  const stats = treeStats(tree);
  const parsed = PassportSchema.safeParse({
    schema: PASSPORT_SCHEMA,
    artifact: {
      kind,
      name: identity.name,
      version: identity.version,
      source: context.source,
      digest,
      files: stats.files,
      bytes: stats.bytes,
    },
    lines: found.lines,
    blindSpots: found.blindSpots,
    signals: found.signals,
    imported: [],
    analysis: { stroq: context.stroqVersion, rules: context.rulesId },
  });
  if (!parsed.success) throw new InspectError('invalid-passport', schemaFault(parsed.error));
  return parsed.data;
}
