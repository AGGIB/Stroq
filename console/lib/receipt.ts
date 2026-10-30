import { ACTION_LABELS } from './incident-comparison';
import type { JournalSummary } from './journal-view';
import { postureCounts, type PostureAudit } from './posture';

/**
 * A plain-text receipt of what Stroq recorded: counts only, safe to paste into a chat or a ticket.
 * Every line comes from numbers and fixed wording. No command, path, URL, tool name, rule text or
 * secret name can appear, because none of them are in the inputs.
 */

const TOP_CLASSES = 5;

const number = (n: number): string => n.toLocaleString('en-US');

function utcClock(iso: string): string {
  return `${iso.slice(11, 16)} UTC`;
}

export const RECEIPT_LIMITS =
  'Recorded policy decisions, not proof that any host stopped anything. Counts cover the newest part of the audit journal only. No commands, paths, URLs or secrets are included.';

/** The receipt as Markdown, or null when there is nothing recorded to report. */
export function buildReceipt(
  summary: JournalSummary,
  posture: PostureAudit | null,
  at: Date,
): string | null {
  if (summary.state !== 'ready' || summary.window.rows === 0) return null;
  const { allow, ask, deny, suspect } = summary.counts;
  const first = summary.window.first;
  const last = summary.window.last;
  const span =
    first !== null && last !== null
      ? ` (${utcClock(first)} to ${utcClock(last)}${summary.window.truncated ? ', the newest part of the journal' : ''})`
      : '';
  const lines = [
    `# Stroq receipt · ${at.toISOString().slice(0, 10)}`,
    '',
    `Recorded actions: ${number(summary.window.rows)}${span}`,
    `- Allowed: ${number(allow)}`,
    `- Asked you: ${number(ask)}`,
    `- Denied: ${number(deny)}`,
    `- Flagged: ${number(suspect)} (results that looked like an instruction to the agent)`,
  ];
  if (summary.unreadable > 0)
    lines.push(`- Lines that could not be read: ${number(summary.unreadable)}`);
  const classes = summary.classes.slice(0, TOP_CLASSES);
  if (classes.length > 0) {
    lines.push('', 'Most common kinds of action');
    for (const entry of classes)
      lines.push(`- ${ACTION_LABELS[entry.class]}: ${number(entry.count)}`);
  }
  if (posture !== null && posture.sources.some((source) => source.state === 'read')) {
    const counts = postureCounts(posture.findings);
    const read = posture.sources.filter((source) => source.state === 'read').length;
    lines.push(
      '',
      `Settings check: ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.info} ${counts.info === 1 ? 'note' : 'notes'} (${read} of ${posture.sources.length} files read)`,
    );
  }
  lines.push('', RECEIPT_LIMITS, '');
  return lines.join('\n');
}
