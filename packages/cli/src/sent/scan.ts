// Finding this machine's own credentials in a session that already happened.
//
// Every other guard in Stroq looks forward: it judges a call before it runs. Once a
// session is over, the question nobody answers is the retroactive one — which of my
// credentials are already in a model provider's inbox, from which session, put there
// by which tool call. This module answers it from two sources, neither of which needs
// Stroq to have been installed at the time:
//
//  - the agent's own transcript, which still holds the text of every tool result, so
//    a value that entered the model's context can be found by matching it; and
//  - Stroq's audit log, for sessions where the hooks were running, which holds no
//    result text at all and so can only speak about tool ARGUMENTS and file reads.
//
// The second is strictly weaker and the report says so; `SentCoverage.toolResultsRead`
// exists so that "found nothing" from the audit log can never be mistaken for the
// same sentence from a transcript.
import { isAbsolute, relative, resolve } from 'node:path';
import {
  candidatesFromText,
  collectStrings,
  displayPath,
  redact,
  redactMatches,
  summarizeInput,
  type AuditEntry,
  type SecretIndex,
  type SecretMatch,
} from '@stroq/core';
import type { Transcript } from '../replay/transcript.js';
import {
  collectCredentials,
  type SentFileEvidence,
  type SentFileRead,
  type SentReport,
  type SentSighting,
} from './report.js';

/**
 * Where the secret index looked, and how much it found there.
 *
 * Passed as plain data rather than read off a `FileSecretIndex` so that the two scan
 * functions stay testable without a real home directory, and so the caller — not this
 * module — decides which working directory's `.env*` files count. That decision has a
 * side effect: `FileSecretIndex` rebuilds itself whenever its source list changes, so
 * pointing it at a directory the user is not standing in would rewrite the shared
 * index on disk. The command therefore passes `process.cwd()`, and the report prints
 * `indexedSources` so a user can see exactly which files the answer rests on.
 */
export interface SentIndexScope {
  readonly cwd: string;
  readonly home: string;
  /** Absolute paths of the credential files the index was built from. */
  readonly sourcePaths: readonly string[];
  readonly indexedSecrets: number;
}

/** Same ceiling a provenance record's `source` uses, for the same reason. */
const MAX_CALL_CHARS = 120;

/**
 * Characters that continue a path. Used to reject a near miss: `.env` must not match
 * inside `.env.example` or `/etc/.env`, because a report that calls an example file a
 * credential file teaches the reader to discount the rest of it.
 */
const PATH_CHAR = /[A-Za-z0-9._~/\\-]/;

/** True when `spelling` occurs in `text` as a whole path rather than as a fragment. */
function mentions(text: string, spelling: string): boolean {
  for (let from = 0; from <= text.length;) {
    const at = text.indexOf(spelling, from);
    if (at < 0) return false;
    const before = text[at - 1];
    const after = text[at + spelling.length];
    const bounded =
      (before === undefined || !PATH_CHAR.test(before)) &&
      (after === undefined || !PATH_CHAR.test(after));
    if (bounded) return true;
    from = at + 1;
  }
  return false;
}

/**
 * The ways one credential file can be written in a tool's arguments.
 *
 * An absolute path and a `~` form mean the same file wherever the session ran, so
 * they are always in. A RELATIVE form does not: `cat .env` names the `.env` of
 * whatever directory that session was in, which is only this machine's indexed `.env`
 * when the two directories are the same. Measured over 92 real transcripts, matching
 * a bare relative path unconditionally reported a credential-file read in 7 of them
 * that were all reads of some other repository's `.env` — so `sessionCwd` has to
 * agree before the relative spellings are used at all, and a source that cannot say
 * where it ran (the audit log records no working directory) gets none.
 */
function spellingsOf(path: string, scope: SentIndexScope, sessionCwd: string | null): string[] {
  const spellings = [path, displayPath(path, scope.home)];
  const sameDirectory = sessionCwd !== null && resolve(sessionCwd) === resolve(scope.cwd);
  const rel = relative(scope.cwd, path);
  if (sameDirectory && rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) {
    spellings.push(rel, `./${rel}`);
  }
  return [...new Set(spellings)];
}

/**
 * Tools whose output is the file their input names, so a credential path in one is a
 * read of that file. `Grep`'s path lives in a field `summarizeInput` never shows,
 * which is why every string leaf of the input is searched rather than the summary.
 */
const FILE_READING_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep']);
/** Tools that run a shell command, which may or may not print the file it names. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash']);

/**
 * What this call establishes about a credential file, or null when the tool is not
 * one that reads files at all.
 *
 * Deliberately a short allow-list rather than "any tool whose input mentions a path".
 * That wider rule, measured against this machine's own transcripts, reported
 * `~/.npmrc` as opened by `ExitPlanMode` and by `Agent` — two tools that read nothing,
 * whose inputs are prose. A tool nobody has checked contributes no file finding,
 * which is the safe direction to be wrong in for a claim this strong.
 */
function fileEvidenceFor(tool: string): SentFileEvidence | null {
  if (FILE_READING_TOOLS.has(tool)) return 'read';
  if (SHELL_TOOLS.has(tool)) return 'named';
  return null;
}

/**
 * Display paths of the indexed credential files this call's arguments name, searched
 * across every string leaf of the input so a path in any field is seen.
 */
function credentialFilesIn(
  input: Readonly<Record<string, unknown>>,
  scope: SentIndexScope,
  sessionCwd: string | null,
): string[] {
  const leaves = collectStrings(input);
  return scope.sourcePaths
    .filter((path) =>
      spellingsOf(path, scope, sessionCwd).some((spelling) =>
        leaves.some((leaf) => mentions(leaf, spelling)),
      ),
    )
    .map((path) => displayPath(path, scope.home));
}

/**
 * A printable description of the call, with every known value taken out of it twice
 * over: once by name, against the values this scan matched, and once structurally by
 * the audit log's own redactor, which catches vendor-shaped tokens the index never
 * knew about. Only then is it clipped, so a clip can never leave half a credential on
 * screen.
 */
function describeCall(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  matches: readonly SecretMatch[],
): string {
  return redact(redactMatches(summarizeInput(tool, input), matches)).slice(0, MAX_CALL_CHARS);
}

/** First-seen wins, so a file read in a loop is one row rather than a hundred. */
function dedupeFiles(files: readonly SentFileRead[]): SentFileRead[] {
  const seen = new Set<string>();
  const out: SentFileRead[] = [];
  for (const file of files) {
    const key = `${file.path}\n${file.tool}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

/**
 * The first and last moment in a set of recorded stamps. Ordered by parsed time
 * rather than lexically, because the session length printed from these two is a
 * measurement: a stamp written with an offset instead of `Z` sorts before every
 * `Z`-suffixed one as text, which would silently stretch or invert the duration.
 */
const stamps = (values: readonly string[]): { first: string | null; last: string | null } => {
  const usable = values
    .filter((v) => !Number.isNaN(Date.parse(v)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return { first: usable[0] ?? null, last: usable[usable.length - 1] ?? null };
};

/** Which agent wrote the transcript, and where it was read from. */
export interface TranscriptSource {
  readonly agent: string;
  readonly path: string;
}

/**
 * Scans a recorded session for values this machine's secret index recognises.
 *
 * The index has to be the REAL one. That is the whole function: it cannot tell you a
 * credential reached a model without knowing the credential, so unlike `stroq replay`
 * — which deliberately runs against a throwaway home so that inspecting history never
 * touches the operator's credential files — this reads `~/.aws/credentials`, `~/.npmrc`,
 * `~/.netrc`, `~/.docker/config.json` and the project's `.env*`. It still never holds
 * a value: matching goes through the same salted-hash lookup the live guard uses, and
 * what comes back is the name and the source.
 *
 * Both halves of a call are scanned. A tool RESULT carrying the value is the finding
 * that matters, because the harness puts that text into the model's next request. A
 * tool ARGUMENT carrying it is reported too: the model could only have written it if
 * the value was already in its context.
 */
export async function scanTranscript(
  transcript: Transcript,
  source: TranscriptSource,
  index: SecretIndex,
  scope: SentIndexScope,
): Promise<SentReport> {
  const sightings: SentSighting[] = [];
  const files: SentFileRead[] = [];
  // Matches found in a call's arguments, kept by tool-use id so the result half of
  // the same call can redact its description against them without looking again.
  const argumentMatches = new Map<string, readonly SecretMatch[]>();
  let calls = 0;
  let results = 0;

  for (const event of transcript.events) {
    if (event.kind === 'pre') {
      calls += 1;
      // The whole input serialised, not the egress-shaped subset `candidateTokens`
      // extracts. That function exists to decide whether a call is about to send a
      // credential somewhere; this one asks the different question of whether the
      // model had the value at all, and a `Write` whose contents are a credential
      // answers it just as well as a `curl` does.
      const matches = await lookup(index, JSON.stringify(event.input) ?? '', scope);
      argumentMatches.set(event.id, matches);
      const call = describeCall(event.tool, event.input, matches);
      for (const match of matches) {
        sightings.push({
          name: match.name,
          source: match.source,
          canary: match.canary,
          via: 'tool_argument',
          tool: event.tool,
          call,
          at: event.at,
        });
      }
      continue;
    }

    results += 1;
    const inResult = await lookup(index, event.resultText, scope);
    const call = describeCall(event.tool, event.input, [
      ...(argumentMatches.get(event.id) ?? []),
      ...inResult,
    ]);
    for (const match of inResult) {
      sightings.push({
        name: match.name,
        source: match.source,
        canary: match.canary,
        via: 'tool_result',
        tool: event.tool,
        call,
        at: event.at,
      });
    }
    // Reported from the `post` half only: a `pre` is a call the agent proposed, and
    // one that was denied or errored never put anything in front of the model.
    const evidence = fileEvidenceFor(event.tool);
    if (evidence !== null) {
      for (const path of credentialFilesIn(event.input, scope, transcript.cwd)) {
        files.push({ path, tool: event.tool, evidence, call, at: event.at });
      }
    }
  }

  return {
    version: 1,
    origin: 'transcript',
    agent: source.agent,
    path: source.path,
    sessionId: transcript.sessionId,
    ...stamps(transcript.events.map((e) => e.at)),
    credentials: collectCredentials(sightings),
    files: dedupeFiles(files),
    coverage: {
      toolResultsRead: true,
      indexedSecrets: scope.indexedSecrets,
      indexedSources: scope.sourcePaths.map((p) => displayPath(p, scope.home)),
      calls,
      results,
    },
  };
}

/** `index.lookup` over free text; skips the call entirely when there is nothing to ask about. */
async function lookup(
  index: SecretIndex,
  text: string,
  scope: SentIndexScope,
): Promise<readonly SecretMatch[]> {
  if (text.length === 0) return [];
  return index.lookup(candidatesFromText(text), scope.cwd);
}

/**
 * The same report for a session Stroq was installed for, built from the audit log.
 *
 * No lookup happens here, because none can: the audit log stores what an action was,
 * never what a tool returned. What it does store is the secret guard's own verdict on
 * each action — `SecretHit` names and sources, recorded at the time — which is better
 * evidence than a re-scan would be, since it was taken against the index as it stood
 * then rather than as it stands now.
 *
 * The cost is that this branch cannot see a credential that only ever appeared in a
 * tool result, which is most of them. `toolResultsRead: false` carries that limit into
 * the report so the formatter can say it out loud.
 */
export function scanAuditLog(
  allEntries: readonly AuditEntry[],
  sessionId: string,
  scope: SentIndexScope,
): SentReport {
  const entries = allEntries.filter((e) => e.sessionId === sessionId);
  const sightings: SentSighting[] = entries.flatMap((entry) =>
    (entry.secrets ?? []).map((hit) => ({
      name: hit.name,
      source: hit.source,
      canary: hit.canary,
      via: 'tool_argument' as const,
      tool: entry.tool,
      call: entry.summary.slice(0, MAX_CALL_CHARS),
      at: entry.ts,
    })),
  );
  // An audit entry keeps only the redacted one-line summary of the call, so unlike
  // the transcript branch there are no other input fields to search — the summary is
  // all there is, and it is searched as one string.
  const files = entries
    .filter((e) => e.phase === 'post')
    .flatMap((entry) => {
      const evidence = fileEvidenceFor(entry.tool);
      if (evidence === null) return [];
      // `null`: an audit entry carries no working directory, so a bare relative path
      // in one cannot be resolved to a file and is deliberately not guessed at.
      return credentialFilesIn({ summary: entry.summary }, scope, null).map((path) => ({
        path,
        tool: entry.tool,
        evidence,
        call: entry.summary.slice(0, MAX_CALL_CHARS),
        at: entry.ts,
      }));
    });

  return {
    version: 1,
    origin: 'audit-log',
    agent: null,
    path: null,
    sessionId,
    ...stamps(entries.map((e) => e.ts)),
    credentials: collectCredentials(sightings),
    files: dedupeFiles(files),
    coverage: {
      toolResultsRead: false,
      indexedSecrets: scope.indexedSecrets,
      indexedSources: scope.sourcePaths.map((p) => displayPath(p, scope.home)),
      calls: entries.filter((e) => e.phase === 'pre').length,
      results: 0,
    },
  };
}
