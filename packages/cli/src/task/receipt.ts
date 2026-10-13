import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLog, type AuditEntry } from '@stroq/core';

/** Missing post events are explicitly unconfirmed: an allow is not evidence of execution. */
export function taskReceipt(entries: readonly AuditEntry[], taskId: string) {
  const pres = entries.filter((entry) => entry.taskId === taskId && entry.phase === 'pre');
  const key = (entry: AuditEntry) => JSON.stringify([entry.sessionId, entry.callId, entry.tool]);
  const posts = new Map<string, { readonly entry: AuditEntry; readonly count: number }>();
  const counts = new Map<string, number>();
  for (const pre of pres) counts.set(key(pre), (counts.get(key(pre)) ?? 0) + 1);
  for (const post of entries.filter((entry) => entry.taskId === taskId && entry.phase === 'post'))
    posts.set(key(post), { entry: post, count: (posts.get(key(post))?.count ?? 0) + 1 });
  return {
    v: 1,
    taskId,
    calls: pres.map((pre) => ({
      callId: pre.callId ?? null,
      tool: pre.tool,
      summary: pre.summary,
      decision: pre.decision,
      scope: pre.scope,
      status:
        pre.decision?.effect === 'allow' &&
        pre.callId !== undefined &&
        counts.get(key(pre)) === 1 &&
        posts.get(key(pre))?.count === 1 &&
        (posts.get(key(pre))?.entry.seq ?? 0) > pre.seq
          ? posts.get(key(pre))?.entry.outcome === 'failed'
            ? 'host-reported-failure'
            : 'host-reported'
          : 'unconfirmed',
    })),
  };
}

export async function writeReceipt(
  home: string,
  taskId: string,
  exitCode: number | null = null,
): Promise<void> {
  const audit = new AuditLog(join(home, 'audit.jsonl'));
  if (!(await audit.verify()).ok)
    throw new Error('cannot issue a receipt from a broken audit chain');
  const entries = await audit.readAll();
  writeFileSync(
    join(home, 'tasks', taskId, 'receipt.json'),
    `${JSON.stringify({ ...taskReceipt(entries, taskId), exitCode }, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' },
  );
}
