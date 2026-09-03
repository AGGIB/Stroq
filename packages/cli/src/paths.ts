import { homedir } from 'node:os';
import { join } from 'node:path';

export function stroqHome(): string {
  return process.env['STROQ_HOME'] ?? join(homedir(), '.stroq');
}
export const sessionsDir = (): string => join(stroqHome(), 'sessions');
export const auditFile = (): string => join(stroqHome(), 'audit.jsonl');
export const logFile = (): string => join(stroqHome(), 'stroq.log');
export const policyFile = (): string => join(stroqHome(), 'policy.yaml');
