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

export const sessionsDir = (): string => sessionsDirIn(stroqHome());
export const auditFile = (): string => auditFileIn(stroqHome());
export const logFile = (): string => join(stroqHome(), 'stroq.log');
export const policyFile = (): string => join(stroqHome(), 'policy.yaml');
export const secretsFile = (): string => secretsFileIn(stroqHome());
