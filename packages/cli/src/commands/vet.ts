import { parseArgs } from 'node:util';
import { parseArgsProblem, usageError } from '../help.js';
import type { ArtifactKind } from '../install/types.js';
import type { VetDeps, VetOptions } from './vet-types.js';

export type { VetDeps, VetOptions } from './vet-types.js';

/**
 * `stroq vet --from <dir>` - read a skill, an MCP server or a plugin before it is added, and show what it
 * asks for or can do.
 *
 * It reads the files and runs none of them: nothing from the folder is executed, nothing is fetched, and
 * the only thing it writes is the file `--out` names. What it prints is a passport, a record of what the
 * reading found and of what it did not look at; it is a reading and not a security certificate.
 *
 * Exit codes: 0 the passport is complete; 1 `--expect` did not match, or a reading failed so that the
 * passport lacks what it finds; 2 the command line cannot be used; 3 the files cannot be read as an artifact.
 *
 * This file holds the options and the parsing. The doing is loaded only when the command runs: the hook
 * process, which starts for every tool call, reads this module and nothing of what follows.
 */

/** The options of the command. Written out here, where `test/help.test.ts` reads them. */
export const VET_OPTIONS = {
  from: { type: 'string' },
  kind: { type: 'string' },
  json: { type: 'boolean', default: false },
  expect: { type: 'string' },
  card: { type: 'boolean', default: false },
  out: { type: 'string' },
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
const EXPECT_ON_WINDOWS =
  '--expect is not available on Windows for a folder: a folder read there has no executable bit, so its ' +
  'digest can differ from the digest of the same files read on Linux or macOS, and a bare digest cannot ' +
  'say which of them it is. Run it on Linux or macOS.';

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
 * The command line, read. `platform` is where the command runs: on Windows `--expect` is refused, because a
 * folder read there has no executable bit and so a digest of it is not the digest of the same files anywhere
 * else. A syntax fault is told before that one, so that a typo is not answered with a fact about the platform.
 */
export function parseVetArgs(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Parsed {
  const read = readValues(args);
  if ('problem' in read) return refuse(read.problem);
  const { values, positionals } = read;
  if (positionals.length > 0) {
    return refuse(
      'the folder is given with --from <dir>; a package name or an address is not read here',
    );
  }
  if (values.from === undefined) return refuse('give the folder to read with --from <dir>');
  if (values.from === '') return refuse('--from needs the folder to read: --from <dir>');
  const kind = kindOf(values.kind);
  if (kind === null) return refuse(`--kind has to be one of ${VET_KINDS.join(', ')}`);
  if (values.json === true && values.card === true) {
    return refuse('--json and --card are each the whole output: give one of them');
  }
  if (values.out === '') return refuse('--out needs the name of a file that does not exist yet');
  const expected = values.expect === undefined ? null : digestOf(values.expect);
  if (values.expect !== undefined && expected === null) return refuse(EXPECT_SYNTAX);
  if (expected !== null && platform === 'win32') return refuse(EXPECT_ON_WINDOWS);
  return {
    ok: true,
    options: {
      from: values.from,
      kind,
      json: values.json === true,
      card: values.card === true,
      expect: expected,
      out: values.out ?? null,
    },
  };
}

export async function runVet(args: readonly string[], deps: VetDeps = {}): Promise<number> {
  const parsed = parseVetArgs(args, deps.platform ?? process.platform);
  if (!parsed.ok) {
    (deps.err ?? ((text: string) => void process.stderr.write(text)))(
      usageError('vet', parsed.error),
    );
    return EXIT_USAGE;
  }
  const { vetFlow } = await import('./vet-flow.js');
  return vetFlow(parsed.options, deps);
}
