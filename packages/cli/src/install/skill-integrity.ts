import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readRegularFile } from '@stroq/core';
import { assertWriteAllowed } from '../harden/atomic.js';
import { passportsFileIn, stroqHome } from '../paths.js';
import { readPassports, SKILL_NAME, type Passports, type SkillRecord } from './lock.js';
import { readDirTree, READ_DIR_BLIND_SPOTS, ReadDirError } from './read-dir.js';
import { checkEntryPath, quotePath } from './safe-path.js';
import { storePath } from './store.js';
import { buildTree, treeDigest } from './tree.js';
import type { Tree, TreeEntry } from './types.js';

export type SkillIntegrityStatus = 'intact' | 'changed' | 'missing' | 'unverifiable';

export interface SkillIntegrityCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly status: SkillIntegrityStatus;
}

export interface SkillIntegrityOptions {
  readonly platform?: NodeJS.Platform;
  readonly stroqHome?: string;
  readonly userHome?: string;
}

/**
 * Validates the store manifest if the store directory for this digest exists.
 * Does not create or modify the store directory.
 */
async function verifyStoreManifest(
  home: string,
  digest: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let folder: string;
  try {
    folder = storePath(home, digest);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }

  let folderStat;
  try {
    folderStat = await lstat(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Absent store directory is permissible (store cleanup or standalone install)
      return { ok: true };
    }
    return { ok: false, reason: (error as Error).message };
  }

  if (folderStat.isSymbolicLink()) {
    return { ok: false, reason: 'store directory is a symbolic link' };
  }
  if (!folderStat.isDirectory()) {
    return { ok: false, reason: 'store path is not a directory' };
  }

  const manifestFile = join(folder, 'manifest.json');
  let manifestStat;
  try {
    manifestStat = await lstat(manifestFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: 'store manifest.json is missing' };
    }
    return { ok: false, reason: (error as Error).message };
  }

  if (manifestStat.isSymbolicLink()) {
    return { ok: false, reason: 'store manifest.json is a symbolic link' };
  }

  const manifestRead = readRegularFile(manifestFile, 4 * 1024 * 1024, { noFollow: true });
  if (manifestRead.kind !== 'text') {
    return { ok: false, reason: 'store manifest is not a bounded regular file' };
  }

  try {
    const raw: unknown = JSON.parse(manifestRead.text);
    if (
      raw === null ||
      typeof raw !== 'object' ||
      !('entries' in raw) ||
      !Array.isArray(raw.entries)
    ) {
      return { ok: false, reason: 'store manifest has invalid schema' };
    }
    const meta = buildTree(raw.entries as readonly TreeEntry[]);
    if (treeDigest(meta) !== digest) {
      return { ok: false, reason: 'store manifest digest does not match confirmed digest' };
    }
  } catch (error) {
    return { ok: false, reason: `store manifest parsing failed: ${(error as Error).message}` };
  }

  return { ok: true };
}

/**
 * Inspects the integrity of a single installed skill record without modifying the filesystem,
 * lockfile, receipts, or store.
 */
export async function checkSingleSkillIntegrity(
  name: string,
  record: SkillRecord,
  context: { isUser: boolean; home: string; platform?: NodeJS.Platform },
): Promise<SkillIntegrityCheck> {
  const userFlag = context.isUser ? ' --user' : '';
  const checkName = `skill ${quotePath(name)}`;

  // Validate lock record structure and digest
  if (
    typeof record.digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.digest) ||
    typeof record.installedTo !== 'string' ||
    record.installedTo === '' ||
    typeof record.root !== 'string' ||
    record.root === '' ||
    !SKILL_NAME.test(name) ||
    !checkEntryPath(name).ok ||
    record.passport?.artifact?.digest !== record.digest
  ) {
    return {
      name: checkName,
      status: 'unverifiable',
      ok: false,
      detail:
        'unverifiable: invalid lock record data; inspect the passports lock and the skill with "stroq vet --from <source>"',
    };
  }

  // Match the installer's logical target before reading any recorded directory.
  const root = resolve(record.root);
  if (resolve(record.installedTo) !== join(root, '.claude', 'skills', name)) {
    return {
      name: checkName,
      status: 'unverifiable',
      ok: false,
      detail: `unverifiable at ${quotePath(record.installedTo)}: recorded path is not the skill installation path; inspect the passports lock before restoring or removing the skill`,
    };
  }

  // lstat checks only the leaf; the installer's read-only check also resolves parents.
  // Resolving the recorded root permits a root deliberately linked to another directory.
  try {
    assertWriteAllowed(record.installedTo, { root, initRule: false });
  } catch (error) {
    const reason =
      (error as { code?: string }).code === 'path-escapes-root'
        ? 'installation path resolves outside its recorded root; symbolic links are not permitted to escape it'
        : 'installation path cannot be resolved safely';
    return {
      name: checkName,
      status: 'unverifiable',
      ok: false,
      detail: `unverifiable at ${quotePath(record.installedTo)}: ${reason}; inspect the installation path and its symbolic links before restoring or removing the skill`,
    };
  }

  // Check the store manifest if present
  const storeCheck = await verifyStoreManifest(context.home, record.digest);
  if (!storeCheck.ok) {
    return {
      name: checkName,
      status: 'unverifiable',
      ok: false,
      detail: `unverifiable at ${quotePath(record.installedTo)}: ${storeCheck.reason}; restore with "stroq add ${name}${userFlag} --restore"`,
    };
  }

  // Inspect the installed skill directory
  let stat;
  try {
    stat = await lstat(record.installedTo);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        name: checkName,
        status: 'missing',
        ok: false,
        detail: `missing at ${quotePath(record.installedTo)}; restore with "stroq add ${name}${userFlag} --restore" or remove with "stroq remove ${name}${userFlag}"`,
      };
    }
    return {
      name: checkName,
      status: 'unverifiable',
      ok: false,
      detail: `unverifiable at ${quotePath(record.installedTo)}: unreadable (${(error as Error).message}); inspect with "stroq vet --from <source>"`,
    };
  }

  if (stat.isSymbolicLink()) {
    return {
      name: checkName,
      status: 'unverifiable',
      ok: false,
      detail: `unverifiable at ${quotePath(record.installedTo)}: symbolic links are not permitted; inspect with "stroq vet --from <source>" or restore with "stroq add ${name}${userFlag} --restore"`,
    };
  }

  if (!stat.isDirectory()) {
    return {
      name: checkName,
      status: 'unverifiable',
      ok: false,
      detail: `unverifiable at ${quotePath(record.installedTo)}: path exists and is not a directory; inspect with "stroq vet --from <source>" or restore with "stroq add ${name}${userFlag} --restore"`,
    };
  }

  // Read installed directory contents
  let tree: Tree;
  let blindSpots: readonly string[];
  try {
    const result = await readDirTree(
      record.installedTo,
      context.platform !== undefined ? { platform: context.platform } : {},
    );
    tree = result.tree;
    blindSpots = result.blindSpots;
  } catch (error) {
    if (error instanceof ReadDirError) {
      if (error.code === 'unreadable') {
        return {
          name: checkName,
          status: 'unverifiable',
          ok: false,
          detail: `unverifiable at ${quotePath(record.installedTo)}: unreadable content (${error.message}); inspect with "stroq vet --from <source>"`,
        };
      }
      if (error.code === 'limit') {
        return {
          name: checkName,
          status: 'unverifiable',
          ok: false,
          detail: `unverifiable at ${quotePath(record.installedTo)}: size or entry limit exceeded (${error.message}); inspect with "stroq vet --from <source>"`,
        };
      }
      if (error.code === 'refused') {
        return {
          name: checkName,
          status: 'unverifiable',
          ok: false,
          detail: `unverifiable at ${quotePath(record.installedTo)}: entry refused (${error.message}); inspect with "stroq vet --from <source>"`,
        };
      }
    }
    return {
      name: checkName,
      status: 'unverifiable',
      ok: false,
      detail: `unverifiable at ${quotePath(record.installedTo)}: ${(error as Error).message}; inspect with "stroq vet --from <source>"`,
    };
  }

  // Refuse symbolic links within the installed tree
  if (tree.entries.some((entry) => entry.kind === 'symlink')) {
    return {
      name: checkName,
      status: 'unverifiable',
      ok: false,
      detail: `unverifiable at ${quotePath(record.installedTo)}: contains symbolic links; inspect with "stroq vet --from <source>" or restore with "stroq add ${name}${userFlag} --restore"`,
    };
  }

  // Compare digests and check for unexpected blind spots (e.g. .git or node_modules added inside)
  const currentDigest = treeDigest(tree);
  const hasUnexpectedBlindSpots = blindSpots.some(
    (spot) => spot !== READ_DIR_BLIND_SPOTS.noExecutableBit,
  );

  if (currentDigest === record.digest && !hasUnexpectedBlindSpots) {
    return {
      name: checkName,
      status: 'intact',
      ok: true,
      detail: `intact at ${quotePath(record.installedTo)}`,
    };
  }

  return {
    name: checkName,
    status: 'changed',
    ok: false,
    detail: `changed at ${quotePath(record.installedTo)}; restore with "stroq add ${name}${userFlag} --restore"`,
  };
}

/**
 * Checks integrity of all installed skills applicable to the current workspace (active user-scope
 * installs and installs belonging to the current project).
 */
export async function checkInstalledSkills(
  cwd: string,
  home: string,
  options: SkillIntegrityOptions = {},
): Promise<readonly SkillIntegrityCheck[]> {
  const stroqHomeDir = options.stroqHome ?? home;
  const passportsFile = passportsFileIn(stroqHomeDir);

  // Check if passports file exists without creating anything
  let passportsStat;
  try {
    passportsStat = await lstat(passportsFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    return [
      {
        name: 'skills',
        ok: false,
        status: 'unverifiable',
        detail: `unverifiable: cannot stat passports.json (${(error as Error).message})`,
      },
    ];
  }

  if (passportsStat.isSymbolicLink()) {
    return [
      {
        name: 'skills',
        ok: false,
        status: 'unverifiable',
        detail: 'unverifiable: passports.json is a symbolic link; refusing to verify',
      },
    ];
  }

  let passports: Passports;
  try {
    passports = await readPassports(stroqHomeDir);
  } catch (error) {
    return [
      {
        name: 'skills',
        ok: false,
        status: 'unverifiable',
        detail: `unverifiable: passports lock is invalid or unreadable (${(error as Error).message})`,
      },
    ];
  }

  const checks: SkillIntegrityCheck[] = [];
  const resolvedCwd = resolve(cwd);
  const resolvedUserHome = resolve(options.userHome ?? homedir());

  const sortedSkills = Object.entries(passports.skills).sort(([a], [b]) => a.localeCompare(b));

  for (const [name, record] of sortedSkills) {
    // Revoked records are not treated as missing active installs
    if (record.status === 'revoked') continue;

    const resolvedRoot = resolve(record.root);
    const isUser = resolvedRoot === resolvedUserHome;
    const isProject = resolvedRoot === resolvedCwd;

    // Another project's installs are not reported as current-project installs
    if (!isUser && !isProject) continue;

    const check = await checkSingleSkillIntegrity(name, record, {
      isUser,
      home: stroqHomeDir,
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
    });
    checks.push(check);
  }

  return checks;
}
