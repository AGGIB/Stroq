import { homedir } from 'node:os';
import { join } from 'node:path';

export function stroqHome(): string {
  return process.env['STROQ_HOME'] ?? join(homedir(), '.stroq');
}

// Layout of a Stroq home directory. `stroqHome()` is the real one; `stroq attack`
// builds throwaway ones with the same layout.
export const sessionsDirIn = (home: string): string => join(home, 'sessions');
export const auditFileIn = (home: string): string => join(home, 'audit.jsonl');
export const secretsFileIn = (home: string): string => join(home, 'secrets.json');
export const installRecordFileIn = (home: string): string => join(home, 'install.json');
export const trustFileIn = (home: string): string => join(home, 'trust.json');
/**
 * The MCP cloak's dictionaries — the only thing Stroq writes that can turn a
 * placeholder back into the value it stood for. A directory of its own, never
 * `secrets.json`, so that "delete every reversible record Stroq holds" is one
 * `rm -rf ~/.stroq/cloak` and so the one-way stores cannot be confused with it.
 */
export const cloakDirIn = (home: string): string => join(home, 'cloak');

export const sessionsDir = (): string => sessionsDirIn(stroqHome());
export const auditFile = (): string => auditFileIn(stroqHome());
export const logFile = (): string => join(stroqHome(), 'stroq.log');
export const policyFile = (): string => join(stroqHome(), 'policy.yaml');
export const secretsFile = (): string => secretsFileIn(stroqHome());
export const installRecordFile = (): string => installRecordFileIn(stroqHome());
export const trustFile = (): string => trustFileIn(stroqHome());
export const cloakDir = (): string => cloakDirIn(stroqHome());
