// One session, summed up for the card: how many shell commands the agent ran and which of them a text
// it had read told it to run (the strict rule, `strict-link.ts`).
//
// The recorded calls are judged in a throwaway engine, exactly as `stroq replay --all` does, and the
// audit entries that engine wrote are what the rule reads. The user's own `~/.stroq` is not touched, no
// key file is read, and nothing runs. A session with no shell command is not replayed at all: it has
// nothing to count, and replaying is the whole cost.
import { isShellTool, type AuditEntry } from '@stroq/core';
import { findRead, replayTranscript } from '../commands/replay.js';
import { readCodexRollout } from '../sent/codex.js';
import { readTranscript, type Transcript } from '../replay/transcript.js';
import { declaredPackages } from './declared-packages.js';
import { leanTranscript } from './lean.js';
import type { DeclaredPackages } from './package-claims.js';
import { readSourceOf } from './read-name.js';
import { hourOf, hoursOf } from './hours.js';
import {
  MAX_TOLD_PER_SESSION,
  type CardAgent,
  type SessionSummary,
  type ToldMoment,
} from './schema.js';
import { strictLink, type LinkEntry } from './strict-link.js';

/** What judges a transcript; replaced in tests. */
export type Replayer = (transcript: Transcript) => Promise<AuditEntry[]>;

export interface SummaryDeps {
  readonly replay?: Replayer;
  /** The packages the session's folder declares; read only when a package link needs it. */
  readonly declared?: (cwd: string | null) => DeclaredPackages;
  /** Judge every result in full, and not only those that could matter (see `lean.ts`). */
  readonly full?: boolean;
}

/** A time a record gave, as ISO 8601, or null: a record can put any text where a time goes. */
function isoOrNull(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** A declaration that is read the first time it is asked, and only then. */
function lazily(read: () => DeclaredPackages): DeclaredPackages {
  let loaded: DeclaredPackages | null = null;
  return {
    has: (name, ecosystem) => {
      loaded ??= read();
      return loaded.has(name, ecosystem);
    },
  };
}

type Link = NonNullable<ReturnType<typeof strictLink>>;

/**
 * Where the text was read, and the file's name when the path is whole. A provenance record keeps the
 * first 120 characters of a read's source; the audit entry of the read, which the replay also made,
 * keeps 300. The longer form is what names the file (see `read-name.ts`); the records are not changed.
 */
function readOf(link: Link, entries: readonly AuditEntry[]): ToldMoment['read'] {
  const { evidence } = link;
  const { source, name } = readSourceOf(
    evidence.tool,
    evidence.source,
    findRead(entries, evidence)?.summary,
  );
  return {
    tool: evidence.tool,
    source,
    ...(name === undefined ? {} : { name }),
    at: evidence.at,
    excerpt: evidence.excerpt,
  };
}

function momentOf(entry: AuditEntry, link: Link, entries: readonly AuditEntry[]): ToldMoment {
  const effect = entry.decision?.effect;
  return {
    shape: link.shape,
    ...(link.pkg === undefined ? {} : { pkg: link.pkg }),
    tool: entry.tool,
    command: entry.summary,
    at: entry.ts,
    decision: effect === 'allow' || effect === 'ask' || effect === 'deny' ? effect : 'none',
    read: readOf(link, entries),
  };
}

const asLinkEntry = (entry: AuditEntry): LinkEntry => ({
  tool: entry.tool,
  summary: entry.summary,
  ...(entry.classes === undefined ? {} : { classes: entry.classes }),
  ...(entry.decision === undefined ? {} : { decision: { effect: entry.decision.effect } }),
  ...(entry.provenance === undefined ? {} : { provenance: entry.provenance }),
});

/** The summary of a transcript already read. */
export async function summarizeTranscript(
  transcript: Transcript,
  agent: CardAgent,
  deps: SummaryDeps = {},
): Promise<SessionSummary> {
  const shellCalls = transcript.events.filter((e) => e.kind === 'pre' && isShellTool(e.tool));
  const commands = shellCalls.length;
  const commandHours = shellCalls.map((e) => hourOf(e.at));
  const base = {
    agent,
    sessionId: transcript.sessionId,
    cwd: transcript.cwd,
    first: isoOrNull(transcript.events[0]?.at),
    last: isoOrNull(transcript.events.at(-1)?.at),
    commands,
  };
  if (commands === 0) return { ...base, told: 0, moments: [], hours: [] };
  const replay = deps.replay ?? replayTranscript;
  const entries = await replay(deps.full === true ? transcript : leanTranscript(transcript));
  const declared = lazily(() =>
    deps.declared === undefined ? declaredPackages(transcript.cwd) : deps.declared(transcript.cwd),
  );
  const kept: { readonly entry: AuditEntry; readonly link: Link }[] = [];
  const toldHours: (number | null)[] = [];
  for (const entry of entries) {
    if (entry.phase !== 'pre' || entry.sessionId !== transcript.sessionId) continue;
    const link = strictLink(asLinkEntry(entry), declared);
    if (link === null) continue;
    toldHours.push(hourOf(entry.ts));
    // The newest are kept: a window cuts the old end of a session off.
    kept.push({ entry, link });
    if (kept.length > MAX_TOLD_PER_SESSION) kept.shift();
  }
  // Only the kept ones are looked up in the log: a session can have a great many told commands.
  const moments = kept.map(({ entry, link }) => momentOf(entry, link, entries));
  return {
    ...base,
    told: toldHours.length,
    moments,
    hours: hoursOf(commandHours, toldHours),
  };
}

/** Reads the session at `path` the way its agent wrote it, and sums it up. */
export async function summarizeSession(
  agent: CardAgent,
  path: string,
  deps: SummaryDeps = {},
): Promise<SessionSummary> {
  const transcript = agent === 'codex' ? await readCodexRollout(path) : await readTranscript(path);
  return summarizeTranscript(transcript, agent, deps);
}
