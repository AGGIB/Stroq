// `stroq sent <session-id>`: a session read from Stroq's own audit log instead of the agent's.
//
// The log keeps, for each call, a redacted one-line summary and the keys the live guard saw in
// its arguments (names and sources, recorded at the time). It keeps no result, so a key that
// only came back in a result is not in it. Where each recorded key went is read from the
// summary: the key's own spot in it was redacted, so every stage of the command is taken as
// carrying it. A call the guard denied keeps the place it would have reached, with a note that the
// log says it was stopped: the log records Stroq's answer, not what the host did with it. A key the
// AI saw is counted with the later calls that could have sent it without showing it.
import { isShellTool, type AuditEntry } from '@stroq/core';
import { isToolName, type Sighting } from './analyze.js';
import { collectFindings } from './findings.js';
import type { Key } from './keys.js';
import { callCouldSend } from './later-commands.js';
import { keyName, NAME_NOT_SHOWN } from './names.js';
import { buildReport, type SentReport } from './report.js';
import { placeOfArgument, type WhereContext } from './where.js';

/** The fields the summary stands for, by tool: what `placeOfArgument` reads. */
function inputOf(tool: string, summary: string): Record<string, unknown> {
  if (isShellTool(tool)) return { command: summary };
  if (tool === 'WebFetch') return { url: summary };
  if (tool === 'WebSearch') return { query: summary };
  if (tool.startsWith('mcp__')) return { summary };
  return { file_path: summary };
}

const stamp = (
  entries: readonly AuditEntry[],
  pick: (a: number, b: number) => number,
): string | null => {
  const times = entries.map((e) => Date.parse(e.ts)).filter((t) => !Number.isNaN(t));
  return times.length === 0 ? null : new Date(times.reduce(pick)).toISOString();
};

/**
 * For each call, how many calls after it could have sent a key without showing it. Calls before
 * the first one that holds a key are not read: no key was seen before them.
 */
function laterCounts(calls: readonly AuditEntry[], cwd: string | null): number[] {
  const first = calls.findIndex((e) => (e.secrets ?? []).length > 0);
  const counts = calls.map(() => 0);
  let after = 0;
  for (let i = calls.length - 1; i >= Math.max(first, 0); i -= 1) {
    counts[i] = after;
    const e = calls[i] as AuditEntry;
    if (callCouldSend({ tool: e.tool, input: inputOf(e.tool, e.summary) }, cwd)) after += 1;
  }
  return counts;
}

/** The report for one session of the audit log, or null when the log has no entry for it. */
export function auditReport(
  all: readonly AuditEntry[],
  sessionId: string,
  ctx: WhereContext & { readonly now: Date; readonly logPath: string },
): SentReport | null {
  const entries = all.filter((e) => e.sessionId === sessionId);
  if (entries.length === 0) return null;
  // The log names keys, it holds no value: an empty value makes every stage count as carrying it.
  const keys: Key[] = [];
  const indexOf = new Map<string, number>();
  const sightings: Sighting[] = [];
  const calls = entries.filter((e) => e.phase === 'pre');
  const after = laterCounts(calls, ctx.cwd);
  for (const [i, entry] of calls.entries()) {
    for (const hit of entry.secrets ?? []) {
      // The log holds the names the guard saw: each is printed only with the shape of a name.
      const name = keyName(hit.name);
      const id = `${name}\n${hit.source}`;
      if (!indexOf.has(id)) {
        indexOf.set(id, keys.length);
        keys.push({ name, source: hit.source, value: '' });
      }
      const key = indexOf.get(id) as number;
      const place = placeOfArgument(
        entry.tool,
        inputOf(entry.tool, entry.summary),
        keys[key] as Key,
        ctx,
      );
      // A tool's name is printed only with the shape of one: an MCP server names its own tools.
      const shaped = isToolName(entry.tool) ? place : { ...place, tool: NAME_NOT_SHOWN };
      const later = after[i] ?? 0;
      sightings.push({
        key,
        place: entry.decision?.effect === 'deny' ? { ...shaped, saidStopped: true } : shaped,
        at: entry.ts,
        ...(later > 0 ? { laterNetwork: later } : {}),
      });
    }
  }
  const findings = collectFindings(keys, [
    { session: { agent: 'audit-log', id: sessionId, path: ctx.logPath, cwd: null }, sightings },
  ]);
  return buildReport({
    scope: 'audit-log',
    now: ctx.now,
    sessions: {
      total: 1,
      agents: {},
      first: stamp(entries, Math.min),
      last: stamp(entries, Math.max),
    },
    keys: { compared: keys.length, files: [], env: 0, unreadable: 0 },
    findings,
    notChecked: [],
    unreadable: 0,
  });
}
