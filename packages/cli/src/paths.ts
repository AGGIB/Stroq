import { homedir } from 'node:os';
import { join } from 'node:path';

export function stroqHome(): string {
  // An empty variable is not a directory: it would put what Stroq keeps in the folder it runs in.
  const set = process.env['STROQ_HOME'];
  return set !== undefined && set !== '' ? set : join(homedir(), '.stroq');
}

// Layout of a Stroq home directory. `stroqHome()` is the real one; `stroq attack`
// builds throwaway ones with the same layout.
export const sessionsDirIn = (home: string): string => join(home, 'sessions');
export const auditFileIn = (home: string): string => join(home, 'audit.jsonl');
export const secretsFileIn = (home: string): string => join(home, 'secrets.json');
export const installRecordFileIn = (home: string): string => join(home, 'install.json');
export const trustFileIn = (home: string): string => join(home, 'trust.json');
/** Decoy files planted with `stroq canary --file`: their paths, never the value inside. */
export const canaryFilesFileIn = (home: string): string => join(home, 'canary-files.json');
/** What `stroq exposure` last saw of the instruction and skill files, by sha256. */
export const inventoryFileIn = (home: string): string => join(home, 'inventory.json');
/**
 * When each host last called `stroq hook <agent>`: one file per agent holding that time, and nothing
 * else. It is how `stroq doctor` can say a hook is run, and not only written down.
 */
export const lastHookDirIn = (home: string): string => join(home, 'last-hook');
/**
 * The MCP cloak's dictionaries — the only thing Stroq writes that can turn a
 * placeholder back into the value it stood for. A directory of its own, never
 * `secrets.json`, so that "delete every reversible record Stroq holds" is one
 * `rm -rf ~/.stroq/cloak` and so the one-way stores cannot be confused with it.
 */
export const cloakDirIn = (home: string): string => join(home, 'cloak');
/**
 * What `stroq harden` remembers about the files it edited: the manifest, and the lock that
 * serialises its writers. A directory of its own so that "forget everything harden did" is one
 * path and the lock never sits among files that are read as data.
 */
export const hardenDirIn = (home: string): string => join(home, 'harden');
export const hardenManifestFileIn = (home: string): string =>
  join(hardenDirIn(home), 'manifest.json');
/**
 * Byte copies of the files `stroq harden` replaced, one directory per apply. Kept apart from
 * everything else Stroq writes because a copy of someone's config is theirs to delete.
 */
export const backupsDirIn = (home: string): string => join(home, 'backups');

export const sessionsDir = (): string => sessionsDirIn(stroqHome());
export const auditFile = (): string => auditFileIn(stroqHome());
export const logFile = (): string => join(stroqHome(), 'stroq.log');
export const policyFile = (): string => join(stroqHome(), 'policy.yaml');
export const secretsFile = (): string => secretsFileIn(stroqHome());
export const installRecordFile = (): string => installRecordFileIn(stroqHome());
export const trustFile = (): string => trustFileIn(stroqHome());
export const inventoryFile = (): string => inventoryFileIn(stroqHome());
export const canaryFilesFile = (): string => canaryFilesFileIn(stroqHome());
export const cloakDir = (): string => cloakDirIn(stroqHome());
export const lastHookDir = (): string => lastHookDirIn(stroqHome());
