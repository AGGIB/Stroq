// What one run of `stroq sent` found, as data: the sessions read, the keys compared, and one
// finding per key that turned up, under the place it went. `--json` prints this object, so its
// shape is documented (docs/GUIDE.md, "The JSON report"). It never holds a key's value.
import { isoTime, type Finding } from './findings.js';
import type { KeySet } from './keys.js';
import type { Agent, SessionRef } from './sessions.js';

export const REPORT_SCHEMA = 'stroq-sent/2';

/** What the run read: every session on the machine, this project's, one session, or Stroq's log. */
export type SentScope = 'machine' | 'project' | 'last' | 'transcript' | 'audit-log';

export interface AgentSessions {
  readonly sessions: number;
  /** The earliest time recorded in any of them, as ISO 8601. */
  readonly oldest: string | null;
}

export interface SessionsRead {
  readonly total: number;
  readonly agents: Readonly<Partial<Record<Agent, AgentSessions>>>;
  readonly first: string | null;
  readonly last: string | null;
  /** `--last`: how many sessions the project has; the newest was read. */
  readonly inProject?: number;
  /** Sessions read whose records name no folder: that folder's `.env` files were not read. */
  readonly noFolder?: number;
  /** `--here`: sessions whose records name no folder and that could not be placed; not read. */
  readonly skipped?: number;
}

export interface KeysCompared {
  readonly compared: number;
  /** The files keys were read from, as a report shows a path. */
  readonly files: readonly string[];
  /** Keys that came from the environment only. */
  readonly env: number;
  /** Key files that exist but could not be read. */
  readonly unreadable: number;
  /** Canaries `stroq canary` planted whose value is in no file read, so not looked for. */
  readonly canariesNotFound?: number;
  /**
   * Session files whose canary check was cut short by too many values of a canary's shape: a
   * planted canary there may have been missed, and the flood itself may be tampering.
   */
  readonly canaryCheckCut?: number;
  /**
   * Key files not read whole, as a report shows a path: too large, or holding more keys than are
   * compared from one folder. Keys past that point were not looked for.
   */
  readonly partial?: readonly string[];
  /** `.env` files not read at all: past the number read in one folder. */
  readonly skippedFiles?: number;
  /** Keys were found but left out by a cap. */
  readonly truncated?: true;
  /** Lines named like a key whose value is not compared: too short, a placeholder, a path. */
  readonly rejectedLines?: number;
  /** Env files one folder below a project folder read, not read. */
  readonly subfolderEnvFiles?: number;
}

/** Whether any key was left out of the comparison: a file not read whole or not read, or a cap. */
export const keysLeftOut = (keys: KeysCompared): boolean =>
  (keys.partial?.length ?? 0) > 0 ||
  (keys.skippedFiles ?? 0) > 0 ||
  keys.truncated === true ||
  (keys.canaryCheckCut ?? 0) > 0 ||
  (keys.rejectedLines ?? 0) > 0 ||
  (keys.subfolderEnvFiles ?? 0) > 0;

/**
 * What was not checked, by a fixed label: Cursor's store when it cannot be read, Cursor's newest
 * changes when they are still in its write-ahead file (`cursorChangesPending`), the saved large
 * outputs past the byte budget of a scan, whose keys are found but not tied to a call, and keys
 * left out of the comparison (`keysLeftOut`).
 */
export type NotChecked =
  | 'cursor'
  | 'cursor-recent'
  | 'saved-outputs'
  | 'key-files'
  | 'search-cut'
  | 'rejected-lines'
  | 'subfolder-env-files'
  | 'no-sessions'
  | 'unreadable-files'
  | 'key-files-unreadable'
  | 'sessions-no-folder'
  | 'sessions-not-placed'
  | 'canaries-not-found'
  | 'work-cut';

/**
 * What no run of the check sees, by a fixed label: a key split, encoded or rebuilt; a send by a
 * script, a file or a variable that does not show the key; keys in `~/.ssh`, kube and gcloud
 * config and the keychain; secrets kept in JSON, YAML or TOML files; the sessions of Copilot,
 * Windsurf and Antigravity; Claude Code sessions it already deleted. The text report says each.
 */
export type Limit =
  | 'encoded-keys'
  | 'unseen-sends'
  | 'ssh-kube-gcloud-keychain'
  | 'secrets-in-json-yaml-toml'
  | 'other-agents'
  | 'deleted-sessions';

export const LIMITS: readonly Limit[] = [
  'encoded-keys',
  'unseen-sends',
  'ssh-kube-gcloud-keychain',
  'secrets-in-json-yaml-toml',
  'other-agents',
  'deleted-sessions',
];

export interface SentReport {
  readonly schema: typeof REPORT_SCHEMA;
  /** The built-in sample of `--try`: made-up key, made-up session. */
  readonly synthetic?: true;
  readonly scope: SentScope;
  /** When the check ran, as ISO 8601. */
  readonly checked: string;
  readonly sessions: SessionsRead;
  readonly keys: KeysCompared;
  /** Most external first. */
  readonly findings: readonly Finding[];
  readonly notChecked: readonly NotChecked[];
  /** Nothing in this run was left unchecked: `notChecked` is empty. The `limits` still hold. */
  readonly complete: boolean;
  /** What no run of the check sees. */
  readonly limits: readonly Limit[];
  /** Session files that could not be read. */
  readonly unreadable: number;
  /**
   * Saved large outputs that were not read into the call that printed them, because the scan's
   * byte budget for them was spent. A key in one is still found, as in the session log.
   */
  readonly savedOutputsSkipped?: number;
  /**
   * Session files and texts whose search for keys was cut short by its bound: many keys sharing
   * a beginning, and a text that repeats it. A key past that point was not looked for.
   */
  readonly searchCut?: number;
  /**
   * Commands that hold a key, past the processor time a run spends reading commands: not read,
   * each key in them maybe sent.
   */
  readonly workCut?: number;
}

const isoOf = (ms: number): string | null => (ms > 0 ? new Date(ms).toISOString() : null);

/** The earliest of two stamps that parse. */
function earliest(a: string | null, b: string | null): string | null {
  if (a === null || Number.isNaN(Date.parse(a))) return b;
  if (b === null || Number.isNaN(Date.parse(b))) return a;
  return Date.parse(b) < Date.parse(a) ? b : a;
}

/** How many sessions each agent has, and the span of time they cover. */
export function sessionsRead(refs: readonly SessionRef[]): SessionsRead {
  const agents: Partial<Record<Agent, AgentSessions>> = {};
  let first: string | null = null;
  let last = 0;
  let noFolder = 0;
  for (const ref of refs) {
    if (ref.cwd === null) noFolder += 1;
    // What a record says its first time is reaches the report only as a time.
    const start = earliest(isoTime(ref.first), isoOf(ref.mtimeMs));
    const seen = agents[ref.agent];
    agents[ref.agent] = {
      sessions: (seen?.sessions ?? 0) + 1,
      oldest: earliest(seen?.oldest ?? null, start),
    };
    first = earliest(first, start);
    last = Math.max(last, ref.mtimeMs);
  }
  return {
    total: refs.length,
    agents,
    first,
    last: isoOf(last),
    ...(noFolder === 0 ? {} : { noFolder }),
  };
}

export function keysCompared(set: KeySet): KeysCompared {
  return {
    compared: set.keys.length,
    files: set.files,
    env: set.envKeys,
    unreadable: set.unreadable,
    ...(set.canariesNotFound > 0 ? { canariesNotFound: set.canariesNotFound } : {}),
    ...((set.canaryCheckCut ?? 0) > 0 ? { canaryCheckCut: set.canaryCheckCut } : {}),
    ...(set.partial.length > 0 ? { partial: set.partial } : {}),
    ...(set.skippedFiles > 0 ? { skippedFiles: set.skippedFiles } : {}),
    ...(set.truncated ? { truncated: true as const } : {}),
    ...(set.rejectedLines > 0 ? { rejectedLines: set.rejectedLines } : {}),
    ...(set.subfolderEnvFiles > 0 ? { subfolderEnvFiles: set.subfolderEnvFiles } : {}),
  };
}

export function buildReport(parts: {
  readonly scope: SentScope;
  readonly now: Date;
  readonly sessions: SessionsRead;
  readonly keys: KeysCompared;
  readonly findings: readonly Finding[];
  readonly notChecked: readonly NotChecked[];
  readonly unreadable: number;
  readonly savedOutputsSkipped?: number;
  readonly searchCut?: number;
  readonly workCut?: number;
  /** The run ran out of time for reading commands, whatever the commands past it held. */
  readonly workSpent?: boolean;
  readonly synthetic?: boolean;
}): SentReport {
  const skipped = parts.savedOutputsSkipped ?? 0;
  const cut = parts.searchCut ?? 0;
  const s = parts.sessions;
  const labels: NotChecked[] = [
    ...(s.total === 0 ? ['no-sessions' as const] : []),
    ...(parts.unreadable > 0 ? ['unreadable-files' as const] : []),
    ...(parts.keys.unreadable > 0 ? ['key-files-unreadable' as const] : []),
    ...((s.noFolder ?? 0) > 0 ? ['sessions-no-folder' as const] : []),
    ...((s.skipped ?? 0) > 0 ? ['sessions-not-placed' as const] : []),
    ...((parts.keys.canariesNotFound ?? 0) > 0 ? ['canaries-not-found' as const] : []),
    ...(skipped > 0 ? ['saved-outputs' as const] : []),
    ...(keysLeftOut(parts.keys) ? ['key-files' as const] : []),
    ...(cut > 0 ? ['search-cut' as const] : []),
    ...((parts.workCut ?? 0) > 0 || parts.workSpent === true ? ['work-cut' as const] : []),
    ...((parts.keys.rejectedLines ?? 0) > 0 ? ['rejected-lines' as const] : []),
    ...((parts.keys.subfolderEnvFiles ?? 0) > 0 ? ['subfolder-env-files' as const] : []),
  ];
  const notChecked = [...parts.notChecked, ...labels.filter((l) => !parts.notChecked.includes(l))];
  return {
    schema: REPORT_SCHEMA,
    ...(parts.synthetic === true ? { synthetic: true as const } : {}),
    scope: parts.scope,
    checked: parts.now.toISOString(),
    sessions: parts.sessions,
    keys: parts.keys,
    findings: parts.findings,
    notChecked,
    complete: notChecked.length === 0,
    limits: LIMITS,
    unreadable: parts.unreadable,
    ...(skipped > 0 ? { savedOutputsSkipped: skipped } : {}),
    ...(cut > 0 ? { searchCut: cut } : {}),
    ...((parts.workCut ?? 0) > 0 || parts.workSpent === true
      ? { workCut: parts.workCut ?? 0 }
      : {}),
  };
}

/**
 * Keys whose farthest place is a call to another company that its result says was stopped. That
 * it was stopped is read from the result, which the call can write: such a key is never counted
 * as having gone nowhere.
 */
export const stoppedTowardOthers = (report: SentReport): number =>
  report.findings.filter((f) => f.tier === 'blocked' && f.place.wouldBe === 'third_party').length;

/** Findings in one tier. */
export const inTier = (report: SentReport, tier: Finding['tier']): readonly Finding[] =>
  report.findings.filter((f) => f.tier === tier);
