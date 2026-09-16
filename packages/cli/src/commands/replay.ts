// `stroq replay` — the causal history of a session.
//
// Every other guard answers "should this call be allowed". Once the session is
// over, nobody can answer the question that actually matters: which piece of
// text the agent read turned into which action. The audit log already holds
// both halves — a `post` entry records what was read and how it scanned, and a
// `pre` entry records the action plus the provenance evidence that links it
// back — so this command reconstructs the graph from data already on disk. It
// adds no telemetry and works on sessions recorded by earlier versions.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  AuditLog,
  ageLabel,
  type AtomKind,
  type AuditEntry,
  type ProvenanceEvidence,
  type SecretHit,
} from '@stroq/core';
import { createEngineAt, loadPolicy } from '../engine-factory.js';
import { auditFile, auditFileIn } from '../paths.js';
import { findTranscripts, readTranscript, type Transcript } from '../replay/transcript.js';

/** One action that traced back to something the agent had read. */
export interface ReplayConsequence {
  readonly action: AuditEntry;
  /** The most specific atom this action carried over from the source. */
  readonly evidence: ProvenanceEvidence;
  /** How many further atoms from the same source this action also carried. */
  readonly alsoCarried: number;
}

/** A piece of content the agent read, and everything that came out of it. */
export interface ReplaySource {
  readonly tool: string;
  readonly source: string;
  readonly at: string;
  /** True when the scan of that content was `suspect`. */
  readonly suspect: boolean;
  /** The `post` entry that recorded the read, when it is still in the log. */
  readonly read: AuditEntry | null;
  readonly consequences: readonly ReplayConsequence[];
}

export interface ReplayModel {
  readonly sessionId: string;
  readonly total: number;
  readonly first: string | null;
  readonly last: string | null;
  readonly sources: readonly ReplaySource[];
  /** Actions whose arguments carried a known secret value. */
  readonly secretActions: readonly AuditEntry[];
  /** Judged actions with no untrusted origin and no secret hit. */
  readonly unlinked: readonly AuditEntry[];
  readonly denied: number;
  readonly asked: number;
}

const CLIP = /…+$/;

const sourceKey = (tool: string, source: string): string => JSON.stringify([tool, source]);

// A single command routinely carries several atoms out of one read: the host, the
// URL it sits in, and the whole pipe-to-shell line. They are one causal link, so
// the most specific atom speaks for it and the rest are counted.
const ATOM_RANK: Readonly<Record<AtomKind, number>> = {
  pipe_shell: 4,
  encoded: 3,
  pkg: 2,
  url: 1,
  host: 0,
};
const atomRank = (ev: ProvenanceEvidence): number => ATOM_RANK[ev.kind] ?? 0;

/**
 * A provenance record clips the tool's input to 120 chars while an audit summary
 * keeps 300, so the two describe the same read with different amounts of tail.
 * Comparing on the shorter one's prefix is what links them.
 */
function sameSource(summary: string, source: string): boolean {
  const a = summary.replace(CLIP, '');
  const b = source.replace(CLIP, '');
  if (a.length === 0 || b.length === 0) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/** The `post` entry that recorded a read, when the log still holds it. */
function findRead(entries: readonly AuditEntry[], ev: ProvenanceEvidence): AuditEntry | null {
  const candidates = entries.filter(
    (e) => e.phase === 'post' && e.tool === ev.tool && sameSource(e.summary, ev.source),
  );
  if (candidates.length === 0) return null;
  // Several reads of the same file are possible; the one at or before the moment
  // the atom was recorded is the read that produced it.
  const at = Date.parse(ev.at);
  const before = candidates.filter((e) => Date.parse(e.ts) <= at + 1000);
  return (before.length > 0 ? before : candidates)[
    (before.length > 0 ? before : candidates).length - 1
  ] as AuditEntry;
}

/** Reads that tainted the session, so they appear even when nothing traced back. */
function taintingReads(entries: readonly AuditEntry[]): AuditEntry[] {
  return entries.filter((e) => e.phase === 'post' && e.scan?.verdict === 'suspect');
}

export function buildReplay(allEntries: readonly AuditEntry[], sessionId: string): ReplayModel {
  const entries = allEntries.filter((e) => e.sessionId === sessionId);
  const actions = entries.filter((e) => e.phase === 'pre');

  const bySource = new Map<string, { source: ReplaySource; list: ReplayConsequence[] }>();
  const ensure = (
    tool: string,
    source: string,
    at: string,
    suspect: boolean,
  ): ReplayConsequence[] => {
    const key = sourceKey(tool, source);
    const existing = bySource.get(key);
    if (existing) return existing.list;
    const list: ReplayConsequence[] = [];
    bySource.set(key, {
      source: {
        tool,
        source,
        at,
        suspect,
        read: findRead(entries, { tool, source, at, suspect, kind: 'url', excerpt: '' }),
        consequences: list,
      },
      list,
    });
    return list;
  };

  // Every read that tainted the session is a node even with no consequence: a
  // session that went suspect and then did nothing is still the thing a user
  // wants to see first.
  for (const read of taintingReads(entries)) {
    ensure(read.tool, read.summary, read.ts, true);
  }

  for (const action of actions) {
    for (const ev of action.provenance ?? []) {
      ensure(ev.tool, ev.source, ev.at, ev.suspect).push({ action, evidence: ev, alsoCarried: 0 });
    }
  }

  for (const group of bySource.values()) {
    const byAction = new Map<number, ReplayConsequence[]>();
    for (const c of group.list) {
      byAction.set(c.action.seq, [...(byAction.get(c.action.seq) ?? []), c]);
    }
    const merged = [...byAction.values()].map((carried) => {
      const best = carried.reduce((a, b) => (atomRank(b.evidence) > atomRank(a.evidence) ? b : a));
      return { ...best, alsoCarried: carried.length - 1 };
    });
    group.list.length = 0;
    group.list.push(...merged.sort((a, b) => a.action.seq - b.action.seq));
  }

  const linked = new Set([...bySource.values()].flatMap((g) => g.list.map((c) => c.action.seq)));
  const secretActions = actions.filter((a) => (a.secrets ?? []).length > 0 && !linked.has(a.seq));
  const secretSeqs = new Set(secretActions.map((a) => a.seq));
  const unlinked = actions.filter((a) => !linked.has(a.seq) && !secretSeqs.has(a.seq));

  const sources = [...bySource.values()]
    .map((g) => ({ ...g.source, consequences: g.list }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  return {
    sessionId,
    total: entries.length,
    first: entries[0]?.ts ?? null,
    last: entries[entries.length - 1]?.ts ?? null,
    sources,
    secretActions,
    unlinked,
    denied: actions.filter((a) => a.decision?.effect === 'deny').length,
    asked: actions.filter((a) => a.decision?.effect === 'ask').length,
  };
}

const RULE_PREVIEW = 3;

function verdictTag(entry: AuditEntry): string {
  const d = entry.decision;
  if (!d) return '';
  if (d.effect === 'deny') return `DENIED  ${d.ruleId ?? 'default'}`;
  if (d.effect === 'ask') return `ASKED   ${d.ruleId ?? 'default'}`;
  return `allowed ${d.ruleId ?? 'default'}`;
}

function readLine(src: ReplaySource): string {
  const scan = src.read?.scan;
  if (!scan) {
    return src.suspect
      ? 'flagged suspicious'
      : 'no rule matched it, but tool output is data, not instructions';
  }
  if (scan.verdict !== 'suspect') {
    return `clean — no rule matched it, but tool output is data, not instructions`;
  }
  const ids = scan.ruleIds.slice(0, RULE_PREVIEW).join(', ');
  const more = scan.ruleIds.length > RULE_PREVIEW ? `, +${scan.ruleIds.length - RULE_PREVIEW}` : '';
  const waived = scan.trusted === true ? ' — waived by stroq trust' : '';
  return `SUSPECT ${scan.score.toFixed(2)} — ${scan.ruleIds.length} rules: ${ids}${more}${waived}`;
}

const secretLine = (s: SecretHit): string =>
  `${s.name} from ${s.source}${s.canary ? ' (canary)' : ''}`;

function consequenceBlock(c: ReplayConsequence, last: boolean): string[] {
  const elbow = last ? '  └─►' : '  ├─►';
  const rail = last ? '     ' : '  │  ';
  const gap = ageLabel(c.evidence.at, new Date(c.action.ts));
  return [
    `${elbow} #${c.action.seq} ${c.action.tool}  ${c.action.summary}`,
    `${rail}   ${verdictTag(c.action)}${' '.repeat(Math.max(1, 34 - verdictTag(c.action).length))}${gap} later`,
    `${rail}   carried over: "${c.evidence.excerpt}" (${c.evidence.kind})` +
      (c.alsoCarried > 0 ? ` and ${c.alsoCarried} more` : ''),
  ];
}

function sourceBlock(src: ReplaySource): string[] {
  const seq = src.read ? `#${src.read.seq} ` : '';
  const head = [`  ■ ${seq}${src.tool}  ${src.source}`, `      ${readLine(src)}`];
  if (src.consequences.length === 0) {
    return [...head, '      nothing traced back to it', ''];
  }
  const body = src.consequences.flatMap((c, i) =>
    consequenceBlock(c, i === src.consequences.length - 1),
  );
  return [...head, '  │', ...body, ''];
}

function duration(model: ReplayModel): string {
  if (!model.first || !model.last) return '';
  return ` · ${ageLabel(model.first, new Date(model.last))} long`;
}

export function formatReplay(model: ReplayModel): string {
  if (model.total === 0) {
    return `no audit entries for session ${model.sessionId}\n`;
  }
  // Distinct actions, not evidence links: one action reached from two different
  // reads is still one action that came from something the agent read.
  const traced = new Set(model.sources.flatMap((s) => s.consequences.map((c) => c.action.seq)))
    .size;
  const lines: string[] = [
    'stroq replay — what the agent did, and what told it to do it',
    '',
    `  session ${model.sessionId} · ${model.total} events${duration(model)} · ` +
      `${model.denied} denied · ${model.asked} asked`,
    '',
  ];

  if (model.sources.length > 0) {
    lines.push('CONTENT THE AGENT READ, AND WHAT CAME OUT OF IT', '');
    for (const src of model.sources) lines.push(...sourceBlock(src));
  }

  if (model.secretActions.length > 0) {
    lines.push('ACTIONS CARRYING A KNOWN SECRET VALUE', '');
    for (const a of model.secretActions) {
      lines.push(`  ● #${a.seq} ${a.tool}  ${a.summary}`);
      lines.push(`      ${verdictTag(a)}`);
      for (const s of a.secrets ?? []) lines.push(`      ${secretLine(s)}`);
      lines.push('');
    }
  }

  if (model.unlinked.length > 0) {
    lines.push(`ACTIONS WITH NO UNTRUSTED ORIGIN (${model.unlinked.length})`, '');
    for (const a of model.unlinked) {
      const tag = a.decision ? a.decision.effect : '-';
      lines.push(`  ○ #${a.seq} ${a.tool}  ${a.summary}`);
      lines.push(`      ${tag}`);
    }
    lines.push('');
  }

  const judged = traced + model.secretActions.length + model.unlinked.length;
  lines.push(
    traced === 0
      ? 'No action in this session traced back to content the agent read.'
      : `${traced} of ${judged} judged actions traced back to content the agent read.`,
  );
  return `${lines.join('\n')}\n`;
}

/** Sessions present in the log, most recently active first. */
export function sessionsIn(entries: readonly AuditEntry[]): string[] {
  const lastSeen = new Map<string, number>();
  for (const e of entries) lastSeen.set(e.sessionId, e.seq);
  return [...lastSeen.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * Replays a recorded transcript through the engine in a throwaway home and returns
 * the audit log it produced.
 *
 * The user's real `~/.stroq` is never touched: sessions, provenance, audit and the
 * secret index all live under a temporary root that is removed afterwards, exactly
 * as `stroq attack` does. Analysing what already happened must not taint a live
 * session or append to the chain that records real decisions.
 */
export async function replayTranscript(transcript: Transcript): Promise<AuditEntry[]> {
  const root = await mkdtemp(join(tmpdir(), 'stroq-replay-'));
  try {
    const home = join(root, 'home');
    const engine = createEngineAt({
      home,
      userHome: join(root, 'user'),
      policy: loadPolicy(),
      env: {},
    });
    const cwd = transcript.cwd ?? process.cwd();
    for (const ev of transcript.events) {
      const base = {
        sessionId: transcript.sessionId,
        toolName: ev.tool,
        toolInput: ev.input,
        cwd,
      };
      try {
        if (ev.kind === 'pre') await engine.pre(base);
        else await engine.post({ ...base, toolResultText: ev.resultText });
      } catch {
        // One malformed recorded call must not abandon the rest of the history.
      }
    }
    return await new AuditLog(auditFileIn(home)).readAll();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runReplay(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      json: { type: 'boolean' },
      list: { type: 'boolean' },
      transcript: { type: 'string' },
      last: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  // A transcript is the agent's own recording, so this path works on sessions that
  // ran before Stroq was ever installed — the one question no live hook can answer
  // after the fact.
  if (values.transcript !== undefined || values.last === true) {
    const path = values.transcript ?? (await findTranscripts(process.cwd()))[0]?.path;
    if (path === undefined) {
      process.stdout.write('no agent transcript found — looked under ~/.claude/projects\n');
      return 1;
    }
    const transcript = await readTranscript(path);
    if (transcript.events.length === 0) {
      process.stdout.write(`no tool calls recorded in ${path}\n`);
      return 1;
    }
    const replayed = await replayTranscript(transcript);
    const model = buildReplay(replayed, transcript.sessionId);
    if (values.json === true) {
      process.stdout.write(`${JSON.stringify(model, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(`${formatReplay(model)}\nreplayed from ${path}\n`);
    return 0;
  }

  const entries = await new AuditLog(auditFile()).readAll();
  const sessions = sessionsIn(entries);

  if (values.list === true) {
    if (sessions.length === 0) {
      process.stdout.write('no audit entries yet\n');
      return 0;
    }
    for (const id of sessions) {
      const n = entries.filter((e) => e.sessionId === id).length;
      process.stdout.write(`${id}  ${n} events\n`);
    }
    return 0;
  }

  const sessionId = positionals[0] ?? sessions[0];
  if (sessionId === undefined) {
    process.stdout.write('no audit entries yet\n');
    return 1;
  }
  const model = buildReplay(entries, sessionId);
  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(model, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(formatReplay(model));
  return model.total === 0 ? 1 : 0;
}
