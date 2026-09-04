import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  AuditLog,
  DEFAULT_POLICY,
  FileProvenanceStore,
  FileSecretIndex,
  FileSessionStore,
  StroqEngine,
  loadBundledRules,
  loadPolicyFile,
  type Policy,
} from '@stroq/core';
import { auditFileIn, policyFile, secretsFileIn, sessionsDirIn, stroqHome } from './paths.js';

export function loadPolicy(): Policy {
  const file = policyFile();
  return existsSync(file) ? loadPolicyFile(file) : DEFAULT_POLICY;
}

/** Where the active policy comes from: the override file's path, or `default`. */
export function policySource(): string {
  const file = policyFile();
  return existsSync(file) ? file : 'default';
}

export interface EngineLocation {
  /** The Stroq home: sessions, provenance, audit log, secret index. */
  readonly home: string;
  /** The user's home directory, where credential files are indexed from. */
  readonly userHome: string;
  readonly policy: Policy;
  /** Environment to hash credential-shaped variables from; defaults to the process environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** An engine with all stores under `home`; `stroq attack` points this at throwaway directories. */
export function createEngineAt(location: EngineLocation): StroqEngine {
  return new StroqEngine({
    rules: loadBundledRules(),
    policy: location.policy,
    sessions: new FileSessionStore(sessionsDirIn(location.home)),
    provenance: new FileProvenanceStore(sessionsDirIn(location.home)),
    audit: new AuditLog(auditFileIn(location.home)),
    secrets: new FileSecretIndex(
      secretsFileIn(location.home),
      location.userHome,
      location.env ?? process.env,
    ),
  });
}

export function createEngine(): StroqEngine {
  return createEngineAt({ home: stroqHome(), userHome: homedir(), policy: loadPolicy() });
}
