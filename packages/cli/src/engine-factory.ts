import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  AuditLog,
  DEFAULT_POLICY,
  FileProvenanceStore,
  FileSecretIndex,
  FileSessionStore,
  FileTrustStore,
  StroqEngine,
  loadBundledRules,
  loadPolicyFile,
  type Policy,
} from '@stroq/core';
import {
  auditFileIn,
  policyFile,
  secretsFileIn,
  sessionsDirIn,
  stroqHome,
  trustFileIn,
} from './paths.js';

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
  /**
   * The clock every store stamps with; defaults to the wall clock.
   *
   * `stroq replay` re-runs a session that already happened, and its output is a
   * claim about elapsed time — "carried over … 47 s later". Left on the wall clock
   * those numbers measure the replay instead of the session, so the transcript path
   * drives this from each recorded event's own timestamp.
   */
  readonly now?: () => Date;
}

/** An engine with all stores under `home`; `stroq attack` points this at throwaway directories. */
export function createEngineAt(location: EngineLocation): StroqEngine {
  const now = location.now;
  return new StroqEngine({
    rules: loadBundledRules(),
    policy: location.policy,
    // Spread rather than `now` so the key is absent when the caller gave none:
    // under exactOptionalPropertyTypes an explicit `undefined` is not the same as
    // leaving an optional property off.
    ...(now === undefined ? {} : { now }),
    sessions: new FileSessionStore(sessionsDirIn(location.home), now),
    provenance: new FileProvenanceStore(sessionsDirIn(location.home), now),
    audit: new AuditLog(auditFileIn(location.home), now),
    secrets: new FileSecretIndex(
      secretsFileIn(location.home),
      location.userHome,
      location.env ?? process.env,
    ),
    // `stroq attack` builds its engine at a throwaway home, so a scenario can never
    // be waived by an entry the operator added to their own list.
    trust: new FileTrustStore(trustFileIn(location.home)),
  });
}

export function createEngine(): StroqEngine {
  return createEngineAt({ home: stroqHome(), userHome: homedir(), policy: loadPolicy() });
}
