import { parseArgs } from 'node:util';
import {
  AuditLog,
  FileSessionStore,
  describeEvidence,
  describeSecretHit,
  type AuditEntry,
  type SessionState,
} from '@stroq/core';
import { auditFile, sessionsDir } from '../paths.js';
import { formatEntry } from './log.js';

function verdictLine(entry: AuditEntry): string {
  if (entry.decision) {
    return `${entry.decision.effect} by ${entry.decision.ruleId ?? 'default'}: ${entry.decision.reason}`;
  }
  return `${entry.scan?.verdict ?? '-'} (score ${(entry.scan?.score ?? 0).toFixed(2)})`;
}

/**
 * One line per thing that tainted the session, naming what it was reading.
 *
 * The tool and rule id alone cannot answer the question a blocked user actually has
 * — "was that my own README or an attack?" — so each source names its file, URL or
 * command too, redacted and clipped where it was recorded. Sessions tainted before
 * that field existed simply print without it.
 */
function taintLines(state: SessionState): string[] {
  if (!state.taint) return ['  taint:   none'];
  const head = `  taint:   suspect since ${state.taint.since}`;
  return [
    head,
    ...state.taint.sources.map(
      (s) => `    from:  ${s.tool}${s.source ? ` ${s.source}` : ''} — ${s.ruleIds.join(', ')}`,
    ),
  ];
}

const SAFE_WORD = /^[\w@%+=:,./-]+$/;
const shellQuote = (word: string): string =>
  SAFE_WORD.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;

/**
 * The way out of a call the user thinks was wrong, where they are reading about it:
 * the command that clears the session, with its real id, and the form that reports it
 * — pre-titled with the rule, so the report starts with the one fact it needs. No
 * issue had ever been filed, and nothing in the CLI said where one would go.
 */
function wrongCallLines(entry: AuditEntry): string[] {
  const decision = entry.decision;
  if (decision === undefined || decision.effect === 'allow') return [];
  const title = encodeURIComponent(`[False positive]: ${decision.ruleId ?? 'default'}`);
  return [
    '',
    `  Wrong call? Clear the session yourself, outside the agent: stroq untaint --session ${shellQuote(entry.sessionId)}`,
    `  and tell us: https://github.com/AGGIB/Stroq/issues/new?template=false_positive.yml&title=${title}`,
  ];
}

export function formatWhy(entry: AuditEntry, state: SessionState, now: Date): string {
  const because = (entry.provenance ?? []).map((e) => `  because: ${describeEvidence(e, now)}`);
  const secretLines = (entry.secrets ?? []).map((s) => `  because: ${describeSecretHit(s)}`);
  const fallback =
    because.length === 0 && secretLines.length === 0 && !state.taint
      ? ['  because: the action itself matches the rule; no untrusted content was involved']
      : [];
  return `${[
    formatEntry(entry),
    `  action:  ${entry.summary}`,
    `  verdict: ${verdictLine(entry)}`,
    ...because,
    ...secretLines,
    ...fallback,
    ...taintLines(state),
    ...wrongCallLines(entry),
  ].join('\n')}\n`;
}

/** Explains the most recent denied/asked action, or the entry given by `--seq`. */
export async function runWhy(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { seq: { type: 'string' } } });
  const entries = await new AuditLog(auditFile()).readAll();
  const seq = values.seq === undefined ? null : Number.parseInt(values.seq, 10);
  const target =
    seq === null
      ? [...entries]
          .reverse()
          .find((e) => e.decision !== undefined && e.decision.effect !== 'allow')
      : entries.find((e) => e.seq === seq);
  if (!target) {
    process.stdout.write(
      seq === null
        ? 'no denied or asked action in the audit log yet\n'
        : `no audit entry with seq ${values.seq}\n`,
    );
    return 1;
  }
  const state = await new FileSessionStore(sessionsDir()).get(target.sessionId);
  process.stdout.write(formatWhy(target, state, new Date()));
  return 0;
}
