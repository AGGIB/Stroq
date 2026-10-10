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
 * What `stroq prove` last found out about each host: one file per agent, `<agent>.json`, in a
 * directory of its own. The caller checks the agent's name; this only joins.
 */
export const liveDirIn = (home: string): string => join(home, 'live');
export const liveResultFileIn = (home: string, agent: string): string =>
  join(liveDirIn(home), `${agent}.json`);
/**
 * What a stand-in for a host answered, kept apart so that it can never be read as the host's result, and
 * what the last live check said when it could not tell, kept apart so that it cannot replace a result
 * that could. An agent name has no dot, so no agent is called the name of either file.
 */
export const liveStandInFileIn = (home: string, agent: string): string =>
  join(liveDirIn(home), `${agent}.stand-in.json`);
export const liveLastFileIn = (home: string, agent: string): string =>
  join(liveDirIn(home), `${agent}.last.json`);

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
export const liveDir = (): string => liveDirIn(stroqHome());
export const liveResultFile = (agent: string): string => liveResultFileIn(stroqHome(), agent);
