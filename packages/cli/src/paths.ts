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
/** The policy a user writes to replace the built-in one. Where it is absent, the built-in one is the policy. */
export const policyFileIn = (home: string): string => join(home, 'policy.yaml');

/**
 * The code the hooks run, which the agent must not be able to replace. Other software knows
 * these by name, so renaming one is a migration: `npx @stroq/cli init` copies the CLI to
 * `<cliDir>/<version>` (the hook it writes points there), the Claude Code plugin's wrapper
 * script installs its pinned copy to `<pluginCliDir>/<version>` (in shell, so `plugin-cli` is
 * spelled there too), and `init --agent openclaw` copies the Gateway plugin into the last.
 */
export const cliDirIn = (home: string): string => join(home, 'cli');
export const pluginCliDirIn = (home: string): string => join(home, 'plugin-cli');
export const openclawPluginDirIn = (home: string): string => join(home, 'openclaw-plugin');

/**
 * Where features still to come keep their state: signing keys, the live check, what `harden` backs
 * up and stores, the passports, the task permits and the bindings. Named ahead of the code that
 * makes them, so that whatever protects a home (`run/sandbox.ts`) covers each from its first file.
 */
export const keysDirIn = (home: string): string => join(home, 'keys');
export const liveDirIn = (home: string): string => join(home, 'live');
export const hardenDirIn = (home: string): string => join(home, 'harden');
export const backupsDirIn = (home: string): string => join(home, 'backups');
export const storeDirIn = (home: string): string => join(home, 'store');
/**
 * Where a runtime pin copies the verified files of an MCP server to run them (`mcp/pin.ts`). Node looks a
 * package up in the folders above the file that asks, so whatever is planted in `run/node_modules`
 * would be found by a pinned server that asks for a package by name.
 */
export const runDirIn = (home: string): string => join(home, 'run');
export const passportsFileIn = (home: string): string => join(home, 'passports.json');
export const passportsLockDirIn = (home: string): string => join(home, 'passports.lock');
export const tasksDirIn = (home: string): string => join(home, 'tasks');
export const bindingsFileIn = (home: string): string => join(home, 'bindings.yaml');

/**
 * What `stroq prove` last found out about each host: one file per agent, `<agent>.json`, in a
 * directory of its own. The caller checks the agent's name; this only joins.
 */
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
/** The reversible-edit manifest, kept beside its writer lock. */
export const hardenManifestFileIn = (home: string): string =>
  join(hardenDirIn(home), 'manifest.json');

export const sessionsDir = (): string => sessionsDirIn(stroqHome());
export const auditFile = (): string => auditFileIn(stroqHome());
export const logFile = (): string => join(stroqHome(), 'stroq.log');
export const policyFile = (): string => policyFileIn(stroqHome());
export const secretsFile = (): string => secretsFileIn(stroqHome());
export const installRecordFile = (): string => installRecordFileIn(stroqHome());
export const trustFile = (): string => trustFileIn(stroqHome());
export const inventoryFile = (): string => inventoryFileIn(stroqHome());
export const canaryFilesFile = (): string => canaryFilesFileIn(stroqHome());
export const cloakDir = (): string => cloakDirIn(stroqHome());
export const lastHookDir = (): string => lastHookDirIn(stroqHome());
export const liveDir = (): string => liveDirIn(stroqHome());
export const liveResultFile = (agent: string): string => liveResultFileIn(stroqHome(), agent);
