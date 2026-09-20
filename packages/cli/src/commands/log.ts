import { parseArgs } from 'node:util';
import { AuditLog, type AuditEntry } from '@stroq/core';
import { auditFile } from '../paths.js';

export function formatEntry(entry: AuditEntry): string {
  // A waived verdict is printed as what it is: the rules still said suspect, and a
  // trusted entry stopped it tainting. Rendering it as a clean line would make an
  // exemption invisible in the one place a reader goes to check what happened.
  const waived = entry.scan?.trusted === true ? ' trusted' : '';
  // A cloak entry records a substitution rather than a verdict, so it has neither a
  // decision nor a scan. Falling through to the scan branch printed it as `-(0.00)`,
  // which reads as "nothing happened" for the one line that says a value was
  // replaced. It names the direction instead, and the placeholders follow below.
  const outcome = entry.decision
    ? `${entry.decision.effect}(${entry.decision.ruleId ?? 'default'})`
    : entry.scan === undefined && entry.cloak !== undefined
      ? `cloak(${entry.cloak[0]?.direction ?? 'cloak'})`
      : `${entry.scan?.verdict ?? '-'}(${(entry.scan?.score ?? 0).toFixed(2)})${waived}`;
  const classes = entry.classes && entry.classes.length > 0 ? ` [${entry.classes.join(',')}]` : '';
  // Placeholders and kinds only — the values are never in the chain (see `CloakEvent`).
  const cloak =
    entry.cloak && entry.cloak.length > 0
      ? ` {${entry.cloak.map((c) => `${c.kind}:${c.placeholder}×${c.count}`).join(' ')}}`
      : '';
  return `${entry.ts} #${entry.seq} ${entry.phase.padEnd(4)} ${entry.tool.padEnd(10)} [${entry.sessionId}] ${outcome}${classes} ${entry.summary}${cloak}`;
}

export async function runLog(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { count: { type: 'string', default: '20' } },
  });
  const parsedCount = Number.parseInt(values.count ?? '20', 10);
  const count = Number.isNaN(parsedCount) ? 20 : Math.max(1, parsedCount);
  const entries = await new AuditLog(auditFile()).readAll();
  if (entries.length === 0) {
    process.stdout.write('no audit entries yet\n');
    return 0;
  }
  for (const entry of entries.slice(-count)) process.stdout.write(`${formatEntry(entry)}\n`);
  return 0;
}
