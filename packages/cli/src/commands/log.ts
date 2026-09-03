import { parseArgs } from 'node:util';
import { AuditLog, type AuditEntry } from '@stroq/core';
import { auditFile } from '../paths.js';

export function formatEntry(entry: AuditEntry): string {
  const outcome = entry.decision
    ? `${entry.decision.effect}(${entry.decision.ruleId ?? 'default'})`
    : `${entry.scan?.verdict ?? '-'}(${(entry.scan?.score ?? 0).toFixed(2)})`;
  const classes = entry.classes && entry.classes.length > 0 ? ` [${entry.classes.join(',')}]` : '';
  return `${entry.ts} #${entry.seq} ${entry.phase.padEnd(4)} ${entry.tool.padEnd(10)} ${outcome}${classes} ${entry.summary}`;
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
