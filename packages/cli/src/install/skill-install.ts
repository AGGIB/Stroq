import { mkdir, mkdtemp, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { assertWriteAllowed } from '../harden/atomic.js';
import { labelOf } from '../commands/vet-flow.js';
import { renderPassport } from '../commands/vet-render.js';
import { confirm, confirmTyped } from '../ui/prompt.js';
import { styleFor } from '../ui/style.js';
import type { Terminal } from '../ui/terminal.js';
import { stroqVersion } from '../version.js';
import { readArchiveFile } from './archive-file.js';
import { inspectTree, INSPECT_RULES_ID, passportIsIncomplete } from './inspect/index.js';
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
import { readDirTree, READ_DIR_BLIND_SPOTS } from './read-dir.js';
import { sourceTypeOf } from './read-source.js';
import { checkEntryPath } from './safe-path.js';
import { auditReceipt } from './receipt.js';
import { collectSkillStore } from './store-gc.js';
import {
  assertPlainDirectory,
  assertWritableTree,
  putStore,
  readStoredTree,
  storePath,
  writeTree,
} from './store.js';
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
}

function requirePerson(options: SkillOptions): void {
  if (!options.terminal.interactive)
    throw new Error(
      'add and remove need a person at a terminal; use stroq vet --from <path> to read without installing',
    );
}

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
  const path = join(root, '.claude', 'skills', nameOf(name));
  if (previous !== undefined && resolve(previous.installedTo) !== path)
    throw new Error('the installed path in the lock is not a skill path');
  assertWriteAllowed(path, { root, initRule: false });
  return { root, path };
}

async function inspectSource(source: string): Promise<{ tree: Tree; passport: Passport }> {
  const type = await sourceTypeOf(source);
  const { tree, blindSpots } =
    type === 'dir' ? await readDirTree(source) : await readArchiveFile(source);
  const passport = inspectTree(tree, {
    kind: 'auto',
    source: { type, label: labelOf(source, type) },
    extraBlindSpots: blindSpots,
    stroqVersion: stroqVersion(),
    rulesId: INSPECT_RULES_ID,
  });
  if (passport.artifact.kind !== 'skill')
    throw new Error('add currently installs skills only; use vet for an MCP server or plugin');
  if (passportIsIncomplete(passport))
    throw new Error('the passport is incomplete; refusing to install');
  assertWritableTree(tree, passport.artifact.digest);
  if (process.platform === 'win32' && tree.entries.some((entry) => entry.exec))
    throw new Error(
      'Windows cannot preserve executable bits in an installed skill; use Linux or macOS for this archive',
    );
  return { tree, passport };
}

async function isDrifted(record: SkillRecord): Promise<boolean> {
  // Do not turn permissions or a missing mount into permission to overwrite: only a digest mismatch
  // or a missing skill is drift. Links always refuse, including under --force.
  if (!(await assertPlainDirectory(record.installedTo))) return true;
  const { tree, blindSpots } = await readDirTree(record.installedTo);
  return (
    blindSpots.some((spot) => spot !== READ_DIR_BLIND_SPOTS.noExecutableBit) ||
    treeDigest(tree) !== record.digest
  );
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

async function ask(options: SkillOptions, passport: Passport, typed: boolean): Promise<void> {
  options.terminal.write(renderPassport(passport));
  const confirmed = typed
    ? await confirmTyped(options.terminal, passport.artifact.digest)
    : await confirm(options.terminal, styleFor(options.terminal), 'Apply this update?', false);
  if (!confirmed) throw new Error('not confirmed; the installed skill was kept');
}

/** Stage beside the target. A failed lock write puts the previous directory back. */
async function replaceSkill(
  tree: Tree,
  digest: string,
  target: string,
  save: () => Promise<void>,
): Promise<void> {
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, '.stroq-stage-'));
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
    if (movedNew) await rm(target, { recursive: true });
    if (movedOld) await rename(backup, target);
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
        tree: await readStoredTree(
          storePath(options.stroqHome, installed!.digest),
          installed!.digest,
        ),
        passport: installed!.passport,
      }
    : await inspectSource(source);
  const name = nameOf(installed === undefined ? made.passport.artifact.name : sourceOrName);
  const prior = Object.hasOwn(initial.skills, name) ? initial.skills[name] : undefined;
  const previous = prior?.status === 'revoked' ? undefined : prior;
  const target = targetOf(name, options, previous);
  if (previous === undefined && (await assertPlainDirectory(target.path)))
    throw new Error('the skill directory already exists outside Stroq; refusing to replace it');
  const material =
    previous === undefined ||
    previous.source !== source ||
    materialChange(previous.passport, made.passport);
  return { name, prior, previous, target, material, restoring, source, made };
}

export async function addSkill(sourceOrName: string, options: SkillOptions): Promise<SkillRecord> {
  requirePerson(options);
  const { name, prior, previous, target, material, restoring, source, made } = await prepareSkill(
    sourceOrName,
    options,
  );
  await ask(options, made.passport, material || restoring);
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
    return next;
  });
}

export async function removeSkill(name: string, options: SkillOptions): Promise<void> {
  requirePerson(options);
  nameOf(name);
  return withPassports(options.stroqHome, async (lock) => {
    const previous = Object.hasOwn(lock.skills, name) ? lock.skills[name] : undefined;
    if (previous === undefined || previous.status === 'revoked')
      throw new Error('the skill is not installed');
    const target = targetOf(name, options, previous);
    const drift = await isDrifted(previous);
    if (drift && options.force !== true) {
      await markDrift(options.stroqHome, lock, name, previous);
      throw new Error('the installed skill drifted; it was kept (use --force to remove it)');
    }
    const yes = await confirm(
      options.terminal,
      styleFor(options.terminal),
      `Remove ${name}${drift ? ' including outside edits' : ''}?`,
      false,
    );
    if (!yes) throw new Error('removal not confirmed');
    // Recheck after the prompt: outside edits made while the person was reading must survive too.
    if ((await isDrifted(previous)) && options.force !== true)
      throw new Error('the skill drifted while confirming; it was kept');
    const exists = await assertPlainDirectory(target.path);
    const stage = exists ? await mkdtemp(join(dirname(target.path), '.stroq-remove-')) : null;
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
    await collectSkillStore(options.stroqHome, lock, name, previous);
  });
}
