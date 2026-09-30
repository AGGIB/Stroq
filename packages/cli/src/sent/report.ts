// The shape of a retroactive exposure report, and the one piece of logic that is
// pure enough to live next to it: turning a flat list of sightings into one row per
// credential.
//
// Nothing in this file ever holds a credential value. A sighting carries the same
// three fields `SecretHit` does — name, source, canary — plus where it was seen. That
// is a deliberate ceiling: the report is printed to a terminal, written to `--json`
// and pasted into issues, and the whole point of the feature would be lost if telling
// someone where a credential appeared in a local record required showing its value.

/** Where a credential's value appeared in a recorded tool interaction. */
export type SentVia =
  /**
   * It was in the recorded text a tool returned. A later model request is possible
   * but is not established by this record alone.
   */
  | 'tool_result'
  /**
   * It was in the recorded arguments of a call. This establishes presence in that
   * call, not how the agent obtained it or where the call's text was delivered.
   */
  | 'tool_argument';

export interface SentOccurrence {
  readonly via: SentVia;
  readonly tool: string;
  /**
   * What the call was, redacted and clipped exactly like a provenance record's
   * `source`: a file path, a URL, a command. Never the tool's output.
   */
  readonly call: string;
  readonly at: string;
}

/** One credential this machine holds, and every place this session carried it. */
export interface SentCredential {
  /** As the secret index names it, e.g. `aws_secret_access_key`. Never the value. */
  readonly name: string;
  /** Where the index read it from: `~/.aws/credentials`, `.env`, `env`, `canary`. */
  readonly source: string;
  readonly canary: boolean;
  /** Total sightings, including the ones past `MAX_OCCURRENCES`. */
  readonly count: number;
  readonly first: string;
  readonly last: string;
  /** The earliest `MAX_OCCURRENCES` sightings — a sample, not the whole history. */
  readonly occurrences: readonly SentOccurrence[];
}

/** One sighting before grouping: a hit plus the call it was seen in. */
export interface SentSighting extends SentOccurrence {
  readonly name: string;
  readonly source: string;
  readonly canary: boolean;
}

/**
 * How strongly this session's use of a credential file is established.
 *
 * The distinction is not pedantry. On real transcripts, matching a credential path
 * anywhere in a tool's input reported `~/.npmrc` as "opened" because an `ExitPlanMode`
 * plan and an `Agent` prompt each mentioned it in passing. Those tools do not read
 * files at all, and the ones that do still differ: a `Read` returns the file, while a
 * shell command that names it may never print a byte of it.
 */
export type SentFileEvidence =
  /** A `Read` or `Grep` call was recorded for the file; its result may be partial or an error. */
  | 'read'
  /** A shell command named the file; whether it printed it depends on the command. */
  | 'named';

/**
 * A credential FILE this session touched. Reported separately from a value because it
 * is a different claim: a supported file tool returned or a shell command named the
 * path, but the report does not establish the full contents or provider delivery.
 * Stroq recognises only the values it has indexed.
 */
export interface SentFileRead {
  /** The display path of the credential file, e.g. `~/.aws/credentials`. */
  readonly path: string;
  readonly tool: string;
  readonly evidence: SentFileEvidence;
  readonly call: string;
  readonly at: string;
}

/**
 * What this run could and could not see. Carried in the report rather than left to
 * the prose because every number above is bounded by it: a report that found nothing
 * because it knew no credentials looks exactly like a clean session unless the
 * coverage says otherwise.
 */
export interface SentCoverage {
  /** False on the audit-log branch, which never stored what a tool returned. */
  readonly toolResultsRead: boolean;
  /** Values the index held. The ceiling on what any scan here can possibly find. */
  readonly indexedSecrets: number;
  /** Display paths of the credential files the index was built from. */
  readonly indexedSources: readonly string[];
  readonly calls: number;
  /** Tool results whose text was actually scanned; 0 on the audit-log branch. */
  readonly results: number;
  /** The folders the project's `.env` files were read from, as a report shows a path. */
  readonly projectDirs?: readonly string[];
  /**
   * How many sessions were recorded for this project when `--last` read the newest of
   * them. Absent when the user named the session, and for the audit-log branch.
   */
  readonly sessionsInProject?: number;
}

export type SentOrigin = 'transcript' | 'audit-log';

export interface SentReport {
  readonly version: 1;
  readonly origin: SentOrigin;
  /** The agent whose transcript this is, or null when it came from the audit log. */
  readonly agent: string | null;
  readonly path: string | null;
  readonly sessionId: string;
  readonly first: string | null;
  readonly last: string | null;
  readonly credentials: readonly SentCredential[];
  readonly files: readonly SentFileRead[];
  readonly coverage: SentCoverage;
}

/**
 * Sightings kept per credential. A credential echoed through three hundred grep hits
 * is one fact, and printing it three hundred times buries the second credential.
 */
export const MAX_OCCURRENCES = 5;

/** Chronological, with unparsable stamps left where they are rather than sorted to 1970. */
function byTime(a: { readonly at: string }, b: { readonly at: string }): number {
  const x = Date.parse(a.at);
  const y = Date.parse(b.at);
  if (Number.isNaN(x) || Number.isNaN(y)) return 0;
  return x - y;
}

const key = (s: SentSighting): string => `${s.name}\n${s.source}`;

/**
 * One row per credential, canaries first and then in the order the session first
 * carried them.
 *
 * A canary leads because it is the one credential with no honest reason to be
 * anywhere: the user planted it precisely to find out whether this happens, so its
 * appearance is a deliberate experiment coming back positive rather than an
 * observation the user has to interpret.
 */
export function collectCredentials(sightings: readonly SentSighting[]): SentCredential[] {
  const groups = new Map<string, SentSighting[]>();
  for (const sighting of sightings) {
    const k = key(sighting);
    groups.set(k, [...(groups.get(k) ?? []), sighting]);
  }
  const rows = [...groups.values()].map((group): SentCredential => {
    const sorted = [...group].sort(byTime);
    const first = sorted[0] as SentSighting;
    const last = sorted[sorted.length - 1] as SentSighting;
    return {
      name: first.name,
      source: first.source,
      canary: first.canary,
      count: sorted.length,
      first: first.at,
      last: last.at,
      occurrences: sorted
        .slice(0, MAX_OCCURRENCES)
        .map(({ via, tool, call, at }): SentOccurrence => ({ via, tool, call, at })),
    };
  });
  return rows.sort((a, b) => {
    if (a.canary !== b.canary) return a.canary ? -1 : 1;
    return byTime({ at: a.first }, { at: b.first });
  });
}
