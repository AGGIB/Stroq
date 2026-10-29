import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  AuditLog,
  DEFAULT_POLICY,
  FileCanaryFiles,
  FileProvenanceStore,
  FileSecretIndex,
  FileSessionStore,
  FileTrustStore,
  StroqEngine,
  loadBundledRules,
  parsePolicy,
  type Policy,
  type ScopeGate,
  type TaskAccessRequestSigner,
} from '@stroq/core';
import {
  auditFileIn,
  canaryFilesFileIn,
  policyFile,
  secretsFileIn,
  sessionsDirIn,
  stroqHome,
  trustFileIn,
} from './paths.js';
import { policySha256 } from './policy/digest.js';

/**
 * Where the policy in force came from. `file` is the override with the digest of what it says
 * (`policySha256`, the hash `stroq attack --json` reports); `default` is the built-in version 1
 * policy, which is what the hook runs under when there is no file.
 */
export type PolicyOrigin =
  | { readonly kind: 'file'; readonly path: string; readonly sha256: string }
  | { readonly kind: 'default'; readonly sha256: string };

export interface LoadedPolicy {
  readonly policy: Policy;
  readonly source: PolicyOrigin;
}

const errnoOf = (error: unknown): string =>
  (error as NodeJS.ErrnoException | undefined)?.code ?? 'error';

/** True only when nothing at all is at `path`: a dangling link is something, and is not absent. */
function nothingAt(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return errnoOf(error) === 'ENOENT';
  }
}

/**
 * The text of the policy file, or null when there is none. Only a missing file (or a home not
 * created yet) means "no override": a file that is there and cannot be read (a link to nothing, a
 * directory, a home that is a file, no permission) is refused, never read as the default, because a
 * policy the user wrote and Stroq silently ignored is weaker protection nobody asked for.
 */
function readPolicyText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ENOENT' && nothingAt(file)) return null;
    throw new Error(
      `the policy file ${file} is there but cannot be read (${code}); Stroq refuses to fall back to the default policy`,
    );
  }
}

/** The policy at `file` (the override in the Stroq home unless told), and where it came from. */
export function loadPolicyWithSource(file: string = policyFile()): LoadedPolicy {
  const text = readPolicyText(file);
  if (text === null)
    return {
      policy: DEFAULT_POLICY,
      source: { kind: 'default', sha256: policySha256(DEFAULT_POLICY) },
    };
  // A file that is not a policy throws here, exactly as the hook always has: no default either.
  const policy = parsePolicy(text);
  return { policy, source: { kind: 'file', path: file, sha256: policySha256(policy) } };
}

/** The policy the hook runs under; the digest is left out because the hook never reports it. */
export function loadPolicy(): Policy {
  const text = readPolicyText(policyFile());
  return text === null ? DEFAULT_POLICY : parsePolicy(text);
}

/** Where the active policy comes from: the override file's path, or `default`. A file that cannot be read throws. */
export function policySource(): string {
  const file = policyFile();
  return readPolicyText(file) === null ? 'default' : file;
}

export interface EngineLocation {
  readonly scope?: ScopeGate;
  /** A trusted task parent's signing closure; never loaded by ordinary hook engines. */
  readonly taskAccessSigner?: TaskAccessRequestSigner;
  /** Keep the task project's credential sources indexed when an event runs in a subdirectory. */
  readonly projectRoot?: string;
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
    // Compiled on the first scan, not here: most PreToolUse calls scan nothing (`EngineOptions.rules`).
    rules: loadBundledRules,
    policy: location.policy,
    ...(location.scope === undefined ? {} : { scope: location.scope }),
    ...(location.taskAccessSigner === undefined
      ? {}
      : { taskAccessSigner: location.taskAccessSigner }),
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
      undefined,
      location.projectRoot === undefined ? [] : [location.projectRoot],
    ),
    // `stroq attack` builds its engine at a throwaway home, so a scenario can never
    // be waived by an entry the operator added to their own list.
    trust: new FileTrustStore(trustFileIn(location.home)),
    canaryFiles: new FileCanaryFiles(canaryFilesFileIn(location.home), location.userHome),
  });
}

export function createEngine(): StroqEngine {
  return createEngineAt({ home: stroqHome(), userHome: homedir(), policy: loadPolicy() });
}
