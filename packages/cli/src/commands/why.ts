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

function taintLine(state: SessionState): string {
  if (!state.taint) return '  taint:   none';
  const sources = state.taint.sources.map((s) => `${s.tool}: ${s.ruleIds.join(', ')}`).join('; ');
  return `  taint:   suspect since ${state.taint.since} (${sources})`;
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
    taintLine(state),
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
