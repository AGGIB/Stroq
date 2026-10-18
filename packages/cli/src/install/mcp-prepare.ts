// Everything `add --kind mcp` works out before it asks a person anything: what the server is (read from the source,
// or from the stored copy for a restore), whether it can be pinned, what it is called, what it replaces, and the entry
// that would be written. Nothing is written here.
import { resolve } from 'node:path';
import { isPlainObject } from '../commands/config-file.js';
import { wrapperStrictArgs } from '../commands/mcp-config.js';
import { labelOf } from '../commands/vet-flow.js';
import { assertWriteAllowed } from '../harden/atomic.js';
import { entrypointOf } from '../mcp/entrypoint.js';
import { stroqVersion } from '../version.js';
import { inspectTree, INSPECT_RULES_ID, passportIsIncomplete } from './inspect/index.js';
import type { Passports, Receipt } from './lock.js';
import { readArchiveFile } from './archive-file.js';
import { currentEntry, entryFor, jsonEqual, loadConfig, serversOf } from './mcp-client-config.js';
import { assertSelfContained } from './mcp-outside-imports.js';
import {
  ENV_NAME,
  nameOf,
  recordOf,
  subjectOf,
  type McpInstallOptions,
  type McpRecord,
} from './mcp-record.js';
import { recordedCwd, recordedTarget, target, targetRules, type McpTarget } from './mcp-target.js';
import { readDirTree } from './read-dir.js';
import { sourceTypeOf } from './read-source.js';
import { assertInstallablePlatform, assertWritableTree, readStoredTreeOf } from './store.js';
import type { Passport, Tree } from './types.js';

async function inspectSource(source: string): Promise<{ tree: Tree; passport: Passport }> {
  const type = await sourceTypeOf(source);
  const { tree, blindSpots } =
    type === 'dir'
      ? await readDirTree(source, { rejectNestedRepositories: true })
      : await readArchiveFile(source);
  const passport = inspectTree(tree, {
    kind: 'mcp',
    source: { type, label: labelOf(source, type) },
    extraBlindSpots: blindSpots,
    stroqVersion: stroqVersion(),
    rulesId: INSPECT_RULES_ID,
  });
  if (passportIsIncomplete(passport))
    throw new Error('the passport is incomplete; refusing to install');
  assertWritableTree(tree, passport.artifact.digest);
  assertInstallablePlatform(tree, process.platform);
  return { tree, passport };
}

/** The tree and passport to install: read from the source, or taken from the stored copy for a restore or rollback. */
async function madeOf(
  sourceOrName: string,
  source: string,
  named: McpRecord | undefined,
  options: McpInstallOptions,
): Promise<{ tree: Tree; passport: Passport }> {
  const target = options.restore ? named : options.rollback ? named?.previous : undefined;
  if (target === undefined) return inspectSource(source);
  return {
    tree: await readStoredTreeOf(options.stroqHome, target.digest, subjectOf(sourceOrName, named!)),
    passport: target.passport,
  };
}

/** What `addMcp` has settled before it asks: the server, what it replaces, and the entry that would be written. */
export interface PreparedMcp {
  readonly name: string;
  /** The source as it will be recorded: the recorded one for an installed name. */
  readonly source: string;
  readonly made: { readonly tree: Tree; readonly passport: Passport };
  readonly digest: string;
  readonly previous: McpRecord | undefined;
  /** The receipts of every earlier install under this name, revoked ones included. */
  readonly history: readonly Receipt[];
  /** The stored tree of the revision this replaces, read and verified. */
  readonly oldTree: Tree | undefined;
  readonly entrypoint: string;
  readonly passEnv: readonly string[];
  readonly selected: McpTarget;
  /** The entry in the client config under this name when it was read, for the check after the question. */
  readonly current: unknown;
  readonly cwd: string;
  readonly original: Record<string, unknown> | null;
  readonly written: Record<string, unknown>;
  /** Whether a typed digest is needed: anything but re-applying what is already confirmed. */
  readonly material: boolean;
}

/** The name, the history and the stored tree of what is installed under it, and the source it must come from. */
async function installedUnder(
  name: string,
  source: string,
  initial: Passports,
  options: McpInstallOptions,
) {
  const previous = recordOf(initial, name);
  const prior = initial.mcp?.[name];
  const history =
    isPlainObject(prior) && Array.isArray(prior['history']) ? (prior['history'] as Receipt[]) : [];
  const oldTree =
    previous === undefined
      ? undefined
      : await readStoredTreeOf(options.stroqHome, previous.digest, subjectOf(name, previous));
  if (previous !== undefined && resolve(previous.source) !== source)
    throw new Error(`this path is not ${name}'s recorded source; remove it first`);
  return { previous, history, oldTree };
}

/** The variables the server may see: those given, else those recorded, each a plain name. */
function passEnvOf(
  options: McpInstallOptions,
  previous: Pick<McpRecord, 'passEnv'> | undefined,
): string[] {
  const passEnv = [...new Set(options.passEnv ?? previous?.passEnv ?? [])];
  if (passEnv.some((variable) => !ENV_NAME.test(variable)))
    throw new Error('--pass-env takes variable names: letters, digits and underscores');
  return passEnv;
}

/** The client config to edit, and the entry that stands in it now; refuses what would overwrite another's work. */
function configFor(
  name: string,
  previous: McpRecord | undefined,
  options: McpInstallOptions,
): { selected: McpTarget; current: unknown } {
  const selected =
    previous !== undefined && options.client === undefined && options.config === undefined
      ? recordedTarget(previous)
      : target(options);
  const { file } = selected;
  if (previous !== undefined && resolve(previous.config) !== file)
    throw new Error('the server is installed in another client config; remove it first');
  assertWriteAllowed(file, targetRules(selected));
  const { config } = loadConfig(file);
  const current = currentEntry(config, name);
  if (previous !== undefined && !jsonEqual(current, previous.written) && options.force !== true)
    throw new Error('the client config entry changed outside Stroq; use remove --force first');
  if (previous === undefined && Object.hasOwn(serversOf(config), name))
    throw new Error('the client config already has a server by this name; refusing to replace it');
  return { selected, current };
}

export async function prepareMcp(
  sourceOrName: string,
  options: McpInstallOptions,
  initial: Passports,
): Promise<PreparedMcp> {
  if (options.restore && options.rollback)
    throw new Error('cannot use --restore and --rollback together');
  const named = recordOf(initial, sourceOrName);
  if (options.restore && named === undefined)
    throw new Error('--restore needs the name of an installed MCP server');
  if (options.rollback) {
    if (named === undefined)
      throw new Error('--rollback needs the name of an installed MCP server');
    if (named.previous === undefined)
      throw new Error(`MCP server ${sourceOrName} has no previous revision to roll back to`);
  }
  const source = named?.source ?? resolve(sourceOrName);
  const made = await madeOf(sourceOrName, source, named, options);
  assertSelfContained(made.tree);
  const name = nameOf(
    options.name ?? (named === undefined ? made.passport.artifact.name : sourceOrName),
  );
  const { previous, history, oldTree } = await installedUnder(name, source, initial, options);
  const base = options.rollback && previous?.previous !== undefined ? previous.previous : previous;
  const entrypoint = entrypointOf(made.tree, options.entrypoint ?? base?.entrypoint);
  const passEnv = passEnvOf(options, base);
  const { selected, current } = configFor(name, previous, options);
  const digest = made.passport.artifact.digest;
  const original = previous === undefined ? null : previous.original;
  const cwd = resolve(
    options.cwd ??
      (previous === undefined
        ? options.project
        : options.rollback && previous.previous?.cwd !== undefined
          ? previous.previous.cwd
          : recordedCwd(previous)),
  );
  const written = entryFor(
    name,
    { digest, entrypoint, passEnv },
    options,
    selected.label,
    cwd,
    original,
    strictArgsOf(base, options.strict),
  );
  const material =
    options.restore === true ||
    previous === undefined ||
    previous.digest !== digest ||
    previous.entrypoint !== entrypoint ||
    !jsonEqual(previous.passEnv, passEnv) ||
    !jsonEqual(previous.written, written);
  return {
    name,
    source,
    made,
    digest,
    previous,
    history,
    oldTree,
    entrypoint,
    passEnv,
    selected,
    current,
    cwd,
    original,
    written,
    material,
  };
}

/** Only the confirmed wrapper supplies inherited checks; --force never promotes flags from a drifted config. */
function strictArgsOf(
  previous: Pick<McpRecord, 'written'> | undefined,
  requested: boolean | undefined,
): readonly string[] {
  const recorded = previous?.written['args'];
  const kept = wrapperStrictArgs(Array.isArray(recorded) ? recorded : []);
  return requested === true && !kept.includes('--strict') ? ['--strict', ...kept] : kept;
}
