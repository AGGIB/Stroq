import { parseArgs } from 'node:util';
import { parseArgsProblem, usageError } from '../help.js';
import type { ArtifactKind } from '../install/types.js';
import type { VetDeps, VetOptions } from './vet-types.js';

export type { VetDeps, VetOptions } from './vet-types.js';

/**
 * `stroq vet --from <dir or .tgz>` or `stroq vet --online <source>` - read a skill, an MCP server or a
 * plugin before it is added, and show what it asks for or can do. The path is a folder, or a tar archive
 * (plain or gzipped) such as `npm pack` or `git archive` writes; online reads from npm, GitHub or an https URL.
 *
 * It reads the files and runs none of them: nothing from the folder or the archive is executed or unpacked
 * to a disk, and the only thing it writes is the file `--out` names. What it prints is a
 * passport, a record of what the reading found and of what it did not look at; it is a reading and not a
 * security certificate.
 *
 * Exit codes: 0 the passport is complete; 1 `--expect` did not match, or a reading failed so that the
 * passport lacks what it finds; 2 the command line cannot be used; 3 the files cannot be read as an artifact
 * (a path that is nothing, an archive that is refused, a folder over a limit, or a fetch that failed).
 *
 * This file holds the options and the parsing. The doing is loaded only when the command runs: the hook
 * process, which starts for every tool call, reads this module and nothing of what follows.
 */

/** The options of the command. Written out here, where `test/help.test.ts` reads them. */
export const VET_OPTIONS = {
  from: { type: 'string' },
  online: { type: 'string' },
  kind: { type: 'string' },
  json: { type: 'boolean', default: false },
  expect: { type: 'string' },
  card: { type: 'boolean', default: false },
  out: { type: 'string' },
  probe: { type: 'boolean', default: false },
  entrypoint: { type: 'string' },
} as const;

const EXIT_USAGE = 2;

/**
 * The kinds of artifact, written out here and not read from `install/types.ts`, whose schemas are built when the
 * module is loaded: this file is loaded by every process that starts the CLI, the hook of an agent included.
 * `vet-args.test.ts` holds the two lists together.
 */
export const VET_KINDS: readonly ArtifactKind[] = ['skill', 'mcp', 'plugin'];

/** A digest of the tree as it is spelled: 64 lower-case hexadecimal digits. */
const DIGEST = /^[0-9a-f]{64}$/;
const DIGEST_PREFIX = /^sha256:/i;

const EXPECT_SYNTAX =
  '--expect has to be a sha-256 digest: 64 hexadecimal digits, written bare or as sha256:<hex>';

type Parsed =
  | { readonly ok: true; readonly options: VetOptions }
  | { readonly ok: false; readonly error: string };

const refuse = (error: string): Parsed => ({ ok: false, error });

/** The digest as the tree spells it, or null when the text is not one. Case is not part of a digest. */
function digestOf(text: string): string | null {
  const bare = text.replace(DIGEST_PREFIX, '').toLowerCase();
  return DIGEST.test(bare) ? bare : null;
}

function readValues(args: readonly string[]) {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: VET_OPTIONS,
      allowPositionals: true,
    });
    return { values, positionals };
  } catch (err) {
    const problem = parseArgsProblem(err);
    if (problem === null) throw err;
    return { problem };
  }
}

/** The kind the user named, `auto` when they named none, or null for a word that is not a kind. */
function kindOf(text: string | undefined): VetOptions['kind'] | null {
  if (text === undefined) return 'auto';
  return VET_KINDS.find((kind) => kind === text) ?? null;
}

/**
 * The command line, read. Whether `--expect` can be used where the command runs is not decided here: on Windows
 * a folder has no executable bit, so a digest of it is not the digest of the same files anywhere else, but an
 * archive carries its own bits and has no such trouble, and only the path says which of the two it is (see
 * `vet-flow.ts`).
 */
export function parseVetArgs(args: readonly string[]): Parsed {
  const read = readValues(args);
  if ('problem' in read) return refuse(read.problem);
  const { values, positionals } = read;
  if (positionals.length > 0) {
    return refuse(
      'the folder or archive is given with --from <dir or .tgz>; an online package or address is read with --online <source>',
    );
  }
  if (values.from !== undefined && values.online !== undefined) {
    return refuse('give either --from <dir or .tgz> or --online <source>, not both');
  }
  if (values.from === undefined && values.online === undefined) {
    return refuse(
      'give the folder or archive to read with --from <dir or .tgz>, or an online package with --online <source>',
    );
  }
  if (values.from === '') {
    return refuse('--from needs the folder or archive to read: --from <dir or .tgz>');
  }
  if (values.online === '') {
    return refuse('--online needs the package or address to read: --online <source>');
  }
  if (values.online !== undefined) {
    if (values.online.startsWith('http://')) {
      return refuse('https only: plain http is refused');
    }
    if (
      !values.online.startsWith('npm:') &&
      !values.online.startsWith('github:') &&
      !values.online.startsWith('https://')
    ) {
      return refuse(
        `unknown source format "${values.online}": expected npm:<package>, github:<owner>/<repo>, or https://...tgz`,
      );
    }
  }
  const kind = kindOf(values.kind);
  if (kind === null) return refuse(`--kind has to be one of ${VET_KINDS.join(', ')}`);
  if (values.json === true && values.card === true) {
    return refuse('--json and --card are each the whole output: give one of them');
  }
  if (values.out === '') return refuse('--out needs the name of a file that does not exist yet');
  const expected = values.expect === undefined ? null : digestOf(values.expect);
  if (values.expect !== undefined && expected === null) return refuse(EXPECT_SYNTAX);
  const common = {
    kind,
    json: values.json === true,
    card: values.card === true,
    expect: expected,
    out: values.out ?? null,
    probe: values.probe === true,
    entrypoint: values.entrypoint,
  };
  const options: VetOptions =
    values.from !== undefined
      ? { ...common, from: values.from, online: null }
      : { ...common, from: null, online: values.online! };
  return {
    ok: true,
    options,
  };
}

export async function runVet(args: readonly string[], deps: VetDeps = {}): Promise<number> {
  const parsed = parseVetArgs(args);
  if (!parsed.ok) {
    (deps.err ?? ((text: string) => void process.stderr.write(text)))(
      usageError('vet', parsed.error),
    );
    return EXIT_USAGE;
  }
  const { vetFlow } = await import('./vet-flow.js');
  return vetFlow(
    parsed.options,
    parsed.options.probe
      ? { terminal: (await import('../ui/terminal.js')).currentTerminal(), ...deps }
      : deps,
  );
}
