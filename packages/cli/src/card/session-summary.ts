// One session, summed up for the card: how many shell commands the agent ran and which of them a text
// it had read told it to run (the strict rule, `strict-link.ts`).
//
// The recorded calls are judged in a throwaway engine, exactly as `stroq replay --all` does, and the
// audit entries that engine wrote are what the rule reads. The user's own `~/.stroq` is not touched, no
// key file is read, and nothing runs. A session with no shell command is not replayed at all: it has
// nothing to count, and replaying is the whole cost.
import { isShellTool, type AuditEntry } from '@stroq/core';
import { replayTranscript } from '../commands/replay.js';
import { readCodexRollout } from '../sent/codex.js';
import { readTranscript, type Transcript } from '../replay/transcript.js';
import { declaredPackages } from './declared-packages.js';
import type { DeclaredPackages } from './package-claims.js';
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

function momentOf(entry: AuditEntry, link: NonNullable<ReturnType<typeof strictLink>>): ToldMoment {
  const effect = entry.decision?.effect;
  return {
    shape: link.shape,
    ...(link.pkg === undefined ? {} : { pkg: link.pkg }),
    tool: entry.tool,
    command: entry.summary,
    at: entry.ts,
    decision: effect === 'allow' || effect === 'ask' || effect === 'deny' ? effect : 'none',
    read: {
      tool: link.evidence.tool,
      source: link.evidence.source,
      at: link.evidence.at,
      excerpt: link.evidence.excerpt,
    },
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
  const commands = transcript.events.filter((e) => e.kind === 'pre' && isShellTool(e.tool)).length;
  const base = {
    agent,
    sessionId: transcript.sessionId,
    cwd: transcript.cwd,
    first: isoOrNull(transcript.events[0]?.at),
    last: isoOrNull(transcript.events.at(-1)?.at),
    commands,
  };
  if (commands === 0) return { ...base, told: 0, moments: [] };
  const replay = deps.replay ?? replayTranscript;
  const entries = await replay(transcript);
  const declared = lazily(() =>
    deps.declared === undefined ? declaredPackages(transcript.cwd) : deps.declared(transcript.cwd),
  );
  const moments: ToldMoment[] = [];
  let told = 0;
  for (const entry of entries) {
    if (entry.phase !== 'pre' || entry.sessionId !== transcript.sessionId) continue;
    const link = strictLink(asLinkEntry(entry), declared);
    if (link === null) continue;
    told += 1;
    if (moments.length < MAX_TOLD_PER_SESSION) moments.push(momentOf(entry, link));
  }
  return { ...base, told, moments };
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
