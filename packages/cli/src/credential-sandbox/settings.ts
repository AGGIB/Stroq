import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { within } from '../commands/config-file.js';
import { withConfigurationLock } from '../config-lock.js';
import { assertWriteAllowed, removeFile, writeFileAtomic } from '../harden/atomic.js';
import { deepEqual, parseJsonDocument, serializeJson } from '../harden/json-doc.js';
import { readTargetStrict } from '../harden/read.js';
import type { JsonObject } from '../harden/types.js';
import { readLedger, sealLedger, type Ledger, type LedgerBody } from './ledger.js';
import { linkTargets } from './links.js';
import {
  addRules,
  BASE_PATHS,
  EXTRA_PATHS,
  hasKnownEntries,
  KEY_PATHS,
  knownEntries,
  removeRules,
  type KeyPath,
  type KnownEntries,
  type OwnedRule,
  type SandboxChoices,
} from './rules.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

interface EditOptions {
  readonly file: string;
  readonly home: string;
  readonly dryRun: boolean;
  readonly choices: SandboxChoices | 'remove' | 'hooks-only';
  readonly hooks: (doc: JsonObject) => JsonObject;
}

/** Entries that match what `stroq init` writes, left in the file because no record proves them Stroq's. */
export interface Unproven {
  /** No record, one that does not verify, or one an interrupted write left open. */
  readonly reason: 'missing' | 'unverified' | 'unresolved';
  readonly receipt: string;
  readonly entries: KnownEntries;
}

export interface SkippedLink {
  readonly path: KeyPath;
  /** Null for a link that leads nowhere. */
  readonly target: string | null;
}

export interface EditResult {
  readonly doc: JsonObject;
  readonly changed: boolean;
  readonly removedRules: boolean;
  /** The sandbox rules this call wrote. */
  readonly added: readonly OwnedRule[];
  /** Links among the chosen key paths whose target was not listed. */
  readonly skippedLinks: readonly SkippedLink[];
  /** On an install: an earlier record did not verify, and a new one took its place. */
  readonly replacedRecord: boolean;
  /** On a removal: what was left because nothing proves Stroq wrote it. */
  readonly unproven?: Unproven;
}

interface Place {
  /** The settings file with every link followed. */
  readonly target: string;
  readonly root: string;
  readonly receipt: string;
  /** The digest of `target`, which names the record and is part of what its tag covers. */
  readonly id: string;
}

const receiptRules = (home: string) => ({ root: home, initRule: false });

function locate(file: string, home: string, usesRecord: boolean): Place {
  if (!isAbsolute(file))
    throw new Error(`Cannot edit Claude Code settings: "${file}" is not an absolute path.`);
  const root = within(resolve(file), homedir()) ? homedir() : dirname(resolve(file));
  const target = assertWriteAllowed(file, { root });
  const id = hash(target);
  const receipt = join(home, 'sandbox', id + '.json');
  if (usesRecord) assertWriteAllowed(receipt, receiptRules(home));
  return { target, root, receipt, id };
}

interface Plan {
  readonly doc: JsonObject;
  readonly owned: readonly OwnedRule[];
  readonly added: readonly OwnedRule[];
  readonly skippedLinks: readonly SkippedLink[];
  /** Whether the record is written, or deleted once it names nothing. Otherwise it is left as it is. */
  readonly tracks: boolean;
}

function planned(
  doc: JsonObject,
  ledger: Ledger,
  choices: EditOptions['choices'],
  place: Place,
  file: string,
): Plan {
  const prior = ledger.kind === 'ok' ? ledger.owned : [];
  const none = { added: [], skippedLinks: [] };
  if (choices === 'hooks-only') return { ...none, doc, owned: prior, tracks: false };
  if (choices === 'remove')
    return { ...none, doc: removeRules(doc, prior), owned: [], tracks: ledger.kind === 'ok' };
  if (ledger.kind === 'unresolved')
    throw new Error(
      `An earlier Stroq edit of ${file} was interrupted, and the file has changed since, so Stroq cannot tell which sandbox entries in it are its own. Nothing was changed. Run "stroq uninstall --user" to see those entries, or run init with --hooks-only to install the hooks alone. The record is kept at ${place.receipt}.`,
    );
  const ids: KeyPath[] = [...BASE_PATHS, ...(choices.extra ? EXTRA_PATHS : [])];
  const links = linkTargets(homedir(), ids);
  const next = addRules(doc, prior, choices, links.targets);
  const tracks = ledger.kind === 'ok' || next.owned.length > 0;
  return { ...next, skippedLinks: links.skipped, tracks };
}

function unprovenIn(doc: JsonObject, ledger: Ledger, receipt: string): Unproven | undefined {
  if (ledger.kind === 'ok') return undefined;
  const entries = knownEntries(doc, linkTargets(homedir(), KEY_PATHS).targets);
  if (ledger.kind !== 'none') return { reason: ledger.kind, receipt, entries };
  return hasKnownEntries(entries) ? { reason: 'missing', receipt, entries } : undefined;
}

interface Write {
  readonly file: string;
  readonly home: string;
  readonly place: Place;
  readonly before: string | null;
  readonly after: string;
  readonly changed: boolean;
  readonly prior: readonly OwnedRule[];
  readonly plan: Plan;
}

/** The two atomic renames are journalled so an interrupted install or removal can be retried. */
async function commit(write: Write): Promise<void> {
  const { file, home, place, before, after, plan } = write;
  const rules = receiptRules(home);
  const record = (value: LedgerBody) =>
    writeFileAtomic(place.receipt, sealLedger(home, place.id, value), rules);
  const checkTarget = () => {
    const moved = assertWriteAllowed(file, { root: place.root }) !== place.target;
    if (moved || readTargetStrict(file) !== before)
      throw new Error('Claude Code settings changed during the edit. Run the command again.');
  };
  if (write.changed) {
    if (plan.tracks) {
      const fingerprint = before === null ? null : hash(before);
      const pending = { before: fingerprint, after: hash(after), owned: plan.owned };
      await record({ owned: write.prior, pending });
    }
    await writeFileAtomic(file, after, { root: place.root, beforeRename: checkTarget });
  }
  if (!plan.tracks) return;
  if (plan.owned.length > 0) await record({ owned: plan.owned });
  else await removeFile(place.receipt, rules);
}

async function edit(options: EditOptions): Promise<EditResult> {
  const { file, home, dryRun, choices, hooks } = options;
  const place = locate(file, home, choices !== 'hooks-only');
  const before = readTargetStrict(file);
  const parsed = parseJsonDocument(before ?? '');
  if (!parsed.ok) throw new Error('Cannot edit Claude Code settings: ' + parsed.detail);
  const fingerprint = before === null ? null : hash(before);
  // A hooks-only run neither reads the record nor writes it.
  const ledger: Ledger =
    choices === 'hooks-only'
      ? { kind: 'none' }
      : readLedger(home, place.receipt, place.id, fingerprint);
  const plan = planned(parsed.doc, ledger, choices, place, file);
  const doc = hooks(plan.doc);
  const changed = !deepEqual(doc, parsed.doc);
  const unproven = choices === 'remove' ? unprovenIn(doc, ledger, place.receipt) : undefined;
  const result: EditResult = {
    doc,
    changed,
    removedRules: choices === 'remove' && !deepEqual(plan.doc, parsed.doc),
    added: plan.added,
    skippedLinks: plan.skippedLinks,
    replacedRecord: ledger.kind === 'unverified' && plan.tracks,
    ...(unproven === undefined ? {} : { unproven }),
  };
  if (dryRun) return result;
  const after = serializeJson(doc, parsed.layout);
  const prior = ledger.kind === 'ok' ? ledger.owned : [];
  await commit({ file, home, place, before, after, changed, prior, plan });
  return result;
}

/**
 * Adds or removes Stroq's hooks, and the sandbox settings a person chose, in one Claude Code user
 * settings file. Only what the record names is ever removed.
 */
export async function editClaudeSettings(options: EditOptions): Promise<EditResult> {
  const run = () => edit(options);
  return options.dryRun ? run() : withConfigurationLock({ home: options.home }, run);
}
