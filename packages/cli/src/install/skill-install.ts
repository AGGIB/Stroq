import { mkdir, mkdtemp, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { assertWriteAllowed } from '../harden/atomic.js';
import { labelOf } from '../commands/vet-flow.js';
import { confirm } from '../ui/prompt.js';
import { styleFor } from '../ui/style.js';
import { outsideLine } from '../ui/layout.js';
import type { Terminal } from '../ui/terminal.js';
import { stroqVersion } from '../version.js';
import { readArchiveFile } from './archive-file.js';
import {
  inspectTree,
  INSPECT_RULES_ID,
  InspectError,
  passportIsIncomplete,
} from './inspect/index.js';
import {
  readPassports,
  SKILL_NAME,
  withPassports,
  writePassports,
  type Passports,
  type Receipt,
  type SkillRecord,
} from './lock.js';
import { materialChange } from './material.js';
import { readDirTree, READ_DIR_BLIND_SPOTS, ReadDirError } from './read-dir.js';
import { confirmSkill } from './skill-confirm.js';
import { sourceTypeOf } from './read-source.js';
import { checkEntryPath } from './safe-path.js';
import { auditReceipt } from './receipt.js';
import { collectSkillStore, tidyStore } from './store-gc.js';
import {
  assertPlainDirectory,
  assertInstallablePlatform,
  assertWritableTree,
  putStore,
  readStoredTreeOf,
  writeTree,
  type StoredSubject,
} from './store.js';
import { skillRemedy } from './remedy.js';
import { treeDigest } from './tree.js';
import type { Passport, Tree } from './types.js';

export interface SkillOptions {
  readonly project: string;
  readonly home: string;
  readonly stroqHome: string;
  readonly terminal: Terminal;
  readonly user?: boolean;
  readonly restore?: boolean;
  readonly force?: boolean;
  /** `--kind skill`: the person says what the folder is, for files that look like more than one kind of artifact. */
  readonly kind?: 'skill';
}

function requirePerson(options: SkillOptions): void {
  if (!options.terminal.interactive)
    throw new Error(
      'add and remove need a person at a terminal; use stroq vet --from <path> to read without installing',
    );
}

/** Who a stored copy is for, with the commands that put it back in the scope the lock record has. */
const subjectOf = (
  name: string,
  record: SkillRecord,
  options: Pick<SkillOptions, 'home' | 'project'>,
): StoredSubject => ({
  kind: 'skill',
  name,
  remedy: skillRemedy(name, record, { home: options.home, project: options.project }),
});

function nameOf(name: string): string {
  if (!SKILL_NAME.test(name) || !checkEntryPath(name).ok)
    throw new Error('a skill name must be 1-64 lower-case letters, digits, underscores or hyphens');
  return name;
}

function targetOf(
  name: string,
  options: SkillOptions,
  previous?: SkillRecord,
): { root: string; path: string } {
  const root = resolve(previous?.root ?? (options.user === true ? options.home : options.project));
  if (previous !== undefined && options.user === true && root !== resolve(options.home))
    throw new Error(
      '--user does not match the installed skill root; remove it before changing scope',
    );
  const path = join(root, '.claude', 'skills', nameOf(name));
  if (previous !== undefined && resolve(previous.installedTo) !== path)
    throw new Error('the installed path in the lock is not a skill path');
  assertWriteAllowed(path, { root, initRule: false });
  return { root, path };
}

/** The passport of a tree as a skill's: the kind the person gave, or the one the files say. */
function passportOfSkill(
  tree: Tree,
  source: string,
  type: 'dir' | 'tarball',
  blindSpots: readonly string[],
  kind: 'skill' | undefined,
): Passport {
  try {
    return inspectTree(tree, {
      kind: kind ?? 'auto',
      source: { type, label: labelOf(source, type) },
      extraBlindSpots: blindSpots,
      stroqVersion: stroqVersion(),
      rulesId: INSPECT_RULES_ID,
    });
  } catch (error) {
    // The message of the inspector says to "say which kind it is"; for add, this is how.
    if (error instanceof InspectError && error.code === 'cannot-tell-kind')
      throw new Error(
        `${error.message}; give --kind skill (or --kind mcp for a server) to stroq add`,
      );
    throw error;
  }
}

async function inspectSource(
  source: string,
  kind: 'skill' | undefined,
): Promise<{ tree: Tree; passport: Passport }> {
  const type = await sourceTypeOf(source);
  const { tree, blindSpots } =
    type === 'dir'
      ? await readDirTree(source, { rejectNestedRepositories: true })
      : await readArchiveFile(source);
  const passport = passportOfSkill(tree, source, type, blindSpots, kind);
  if (passport.artifact.kind !== 'skill')
    throw new Error('add currently installs skills only; use vet for an MCP server or plugin');
  if (passportIsIncomplete(passport))
    throw new Error('the passport is incomplete; refusing to install');
  assertWritableTree(tree, passport.artifact.digest);
  assertInstallablePlatform(tree, process.platform);
  return { tree, passport };
}

async function isDrifted(record: SkillRecord): Promise<boolean> {
  // Do not turn permissions or a missing mount into permission to overwrite: only a digest mismatch
  // or a missing skill is drift. A refused/oversized outside entry is also drift; the reader never
  // follows links, and replacing/removing the installed directory itself still refuses a link.
  if (!(await assertPlainDirectory(record.installedTo))) return true;
  try {
    const { tree, blindSpots } = await readDirTree(record.installedTo);
    return (
      blindSpots.some((spot) => spot !== READ_DIR_BLIND_SPOTS.noExecutableBit) ||
      treeDigest(tree) !== record.digest
    );
  } catch (error) {
    if (error instanceof ReadDirError && (error.code === 'refused' || error.code === 'limit'))
      return true;
    throw error;
  }
}

async function markDrift(
  home: string,
  lock: Passports,
  name: string,
  record: SkillRecord,
): Promise<void> {
  await writePassports(home, {
    ...lock,
    skills: { ...lock.skills, [name]: { ...record, status: 'drifted' } },
  });
}

function receipt(
  name: string,
  action: Receipt['action'],
  from: string | null,
  to: string | null,
  material: boolean,
): Receipt {
  return {
    v: 1,
    at: new Date().toISOString(),
    action,
    name,
    from,
    to,
    material,
    confirmed: true,
    stroq: stroqVersion(),
  };
}

/** Stage on the same filesystem, outside the host's skills directory. */
async function replaceSkill(
  tree: Tree,
  digest: string,
  target: string,
  save: () => Promise<void>,
): Promise<void> {
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(dirname(parent), '.stroq-stage-'));
  const backup = `${stage}-old`;
  let movedOld = false;
  let movedNew = false;
  try {
    await writeTree(tree, stage, digest);
    if (await assertPlainDirectory(target)) {
      await rename(target, backup);
      movedOld = true;
    }
    await rename(stage, target);
    movedNew = true;
    await save();
  } catch (error) {
    try {
      if (movedNew) await rm(target, { recursive: true });
    } finally {
      if (movedOld) await rename(backup, target);
    }
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  if (movedOld) await rm(backup, { recursive: true });
}

async function prepareSkill(sourceOrName: string, options: SkillOptions) {
  const initial = await readPassports(options.stroqHome);
  const installed = Object.hasOwn(initial.skills, sourceOrName)
    ? initial.skills[sourceOrName]
    : undefined;
  if (options.restore === true && (installed === undefined || installed.status === 'revoked'))
    throw new Error('--restore needs the name of an installed skill');
  const restoring = options.restore === true;
  const source = installed?.source ?? resolve(sourceOrName);
  const made = restoring
    ? {
        tree: await readStoredTreeOf(
          options.stroqHome,
          installed!.digest,
          subjectOf(sourceOrName, installed!, options),
        ),
        passport: installed!.passport,
      }
    : await inspectSource(source, options.kind);
  const name = nameOf(installed === undefined ? made.passport.artifact.name : sourceOrName);
  const prior = Object.hasOwn(initial.skills, name) ? initial.skills[name] : undefined;
  const previous = prior?.status === 'revoked' ? undefined : prior;
  if (previous !== undefined && installed === undefined && resolve(previous.source) !== source)
    throw new Error(
      `this path is not ${name}'s recorded source; use stroq add ${name} or remove it first`,
    );
  const target = targetOf(name, options, previous);
  if (previous === undefined && (await assertPlainDirectory(target.path)))
    throw new Error('the skill directory already exists outside Stroq; refusing to replace it');
  const oldTree =
    previous === undefined
      ? undefined
      : await readStoredTreeOf(
          options.stroqHome,
          previous.digest,
          subjectOf(name, previous, options),
        );
  const material =
    previous === undefined ||
    previous.source !== source ||
    materialChange(previous.passport, made.passport, { before: oldTree!, after: made.tree });
  return { name, prior, previous, target, material, restoring, source, made, oldTree };
}

export async function addSkill(sourceOrName: string, options: SkillOptions): Promise<SkillRecord> {
  requirePerson(options);
  const prepared = await prepareSkill(sourceOrName, options);
  const { name, prior, previous, target, material, restoring, source, made } = prepared;
  if (previous !== undefined && !restoring && (await isDrifted(previous))) {
    await withPassports(options.stroqHome, async (lock) => {
      if (JSON.stringify(lock.skills[name]) !== JSON.stringify(prior))
        throw new Error('the lock changed before confirming; read and confirm again');
      await markDrift(options.stroqHome, lock, name, previous);
    });
    throw new Error(
      'the installed skill drifted; use add <name> --restore to restore the confirmed bytes',
    );
  }
  await confirmSkill(options.terminal, prepared);
  return withPassports(options.stroqHome, async (lock) => {
    if (JSON.stringify(lock.skills[name]) !== JSON.stringify(prior))
      throw new Error('the lock changed while confirming; read and confirm again');
    targetOf(name, options, previous);
    const drift = previous !== undefined && (await isDrifted(previous));
    if (drift && !restoring) {
      await markDrift(options.stroqHome, lock, name, previous);
      throw new Error(
        'the installed skill drifted; use add <name> --restore to restore the confirmed bytes',
      );
    }
    if (previous === undefined && (await assertPlainDirectory(target.path)))
      throw new Error('the skill directory now exists; refusing to replace it');
    const digest = made.passport.artifact.digest;
    await putStore(options.stroqHome, made.tree, digest);
    const action = restoring ? 'restore' : previous === undefined ? 'add' : 'update';
    const record = receipt(name, action, previous?.digest ?? null, digest, material);
    const next: SkillRecord = {
      kind: 'skill',
      status: 'confirmed',
      source,
      digest,
      passport: made.passport,
      installedTo: target.path,
      root: target.root,
      history: [...(prior?.history ?? []), record],
    };
    await replaceSkill(made.tree, digest, target.path, async () =>
      writePassports(options.stroqHome, { ...lock, skills: { ...lock.skills, [name]: next } }),
    );
    await auditReceipt(options.stroqHome, record);
    if (previous !== undefined)
      await tidyStore(options.terminal, previous.digest, () =>
        collectSkillStore(
          options.stroqHome,
          { ...lock, skills: { ...lock.skills, [name]: next } },
          '',
          previous,
        ),
      );
    return next;
  });
}

export async function removeSkill(name: string, options: SkillOptions): Promise<void> {
  requirePerson(options);
  nameOf(name);
  const initial = await readPassports(options.stroqHome);
  const previous = Object.hasOwn(initial.skills, name) ? initial.skills[name] : undefined;
  if (previous === undefined || previous.status === 'revoked')
    throw new Error('the skill is not installed');
  const target = targetOf(name, options, previous);
  const drift = await isDrifted(previous);
  if (drift && options.force !== true) {
    await withPassports(options.stroqHome, async (lock) => {
      if (JSON.stringify(lock.skills[name]) !== JSON.stringify(previous))
        throw new Error('the lock changed before confirming; read and confirm again');
      await markDrift(options.stroqHome, lock, name, previous);
    });
    throw new Error('the installed skill drifted; it was kept (use --force to remove it)');
  }
  options.terminal.write(
    `Remove ${name} from ${outsideLine(JSON.stringify(target.path))}\nSource ${outsideLine(JSON.stringify(previous.source))}\nPrevious sha256:${previous.digest}\n`,
  );
  const yes = await confirm(
    options.terminal,
    styleFor(options.terminal),
    `Remove ${name}${drift || options.force === true ? ' including outside edits' : ''}?`,
    false,
  );
  if (!yes) throw new Error('removal not confirmed');
  return withPassports(options.stroqHome, async (lock) => {
    if (JSON.stringify(lock.skills[name]) !== JSON.stringify(previous))
      throw new Error('the lock changed while confirming; read and confirm again');
    targetOf(name, options, previous);
    // Recheck after the prompt: outside edits made while the person was reading must survive too.
    if ((await isDrifted(previous)) && options.force !== true)
      throw new Error('the skill drifted while confirming; it was kept');
    const exists = await assertPlainDirectory(target.path);
    const stage = exists
      ? await mkdtemp(join(dirname(dirname(target.path)), '.stroq-remove-'))
      : null;
    if (stage !== null) {
      await rmdir(stage);
      await rename(target.path, stage);
    }
    const record = receipt(name, 'remove', previous.digest, null, false);
    const next = {
      ...previous,
      status: 'revoked' as const,
      history: [...previous.history, record],
    };
    try {
      await writePassports(options.stroqHome, {
        ...lock,
        skills: { ...lock.skills, [name]: next },
      });
    } catch (error) {
      if (stage !== null) await rename(stage, target.path);
      throw error;
    }
    if (stage !== null) await rm(stage, { recursive: true });
    await auditReceipt(options.stroqHome, record);
    await tidyStore(options.terminal, previous.digest, () =>
      collectSkillStore(options.stroqHome, lock, name, previous),
    );
  });
}
