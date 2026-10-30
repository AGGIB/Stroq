import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { hashEntry } from '@stroq/core';
import type { McpCallControlCurrent, McpCallControlInspection } from '../lib/mcp-call-controls.ts';
const sha = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const empty = (status: 'unobserved' | 'unavailable'): McpCallControlInspection['observation'] => ({
  status,
  at: null,
  eventId: null,
  invocationSha256: null,
  reason: null,
});
async function auditTail(home: string): Promise<string | null> {
  let file;
  try {
    if ((await realpath(home)) !== home) return null;
    const root = await lstat(home);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      (root.mode & 0o022) !== 0 ||
      (process.getuid && root.uid !== process.getuid())
    )
      return null;
    const path = join(home, 'audit.jsonl'),
      before = await lstat(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 ||
      (process.getuid && before.uid !== process.getuid())
    )
      return null;
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.nlink !== 1
    )
      return null;
    const offset = Math.max(0, opened.size - 1024 * 1024),
      bytes = Buffer.alloc(Math.min(opened.size, 1024 * 1024));
    const read = await file.read(bytes, 0, bytes.length, offset),
      after = await file.stat(),
      current = await lstat(path);
    if (
      read.bytesRead !== bytes.length ||
      after.size < opened.size ||
      current.ino !== opened.ino ||
      current.dev !== opened.dev ||
      current.nlink !== 1
    )
      return null;
    const start = offset > 0 ? bytes.indexOf(10) + 1 : 0;
    if (offset > 0 && start === 0) return null;
    return new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(start));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? '' : null;
  } finally {
    await file?.close();
  }
}
/** One bounded audit capture for at most 64 exact controls. No liveness or full-journal attestation. */
export async function readMcpCallControlObservations(
  home: string,
  currents: readonly McpCallControlCurrent[],
  now: number,
): Promise<Map<string, McpCallControlInspection['observation']>> {
  if (currents.length > 64 || new Set(currents.map((c) => c.controlId)).size !== currents.length)
    throw new Error('mcp-call-control-unavailable');
  const result = new Map<string, McpCallControlInspection['observation']>();
  for (const current of currents) result.set(current.controlId, empty('unobserved'));
  if (!currents.length) return result;
  const tail = await auditTail(home);
  if (tail === null) {
    for (const current of currents) result.set(current.controlId, empty('unavailable'));
    return result;
  }
  const remaining = new Map(currents.map((c) => [c.controlId, c]));
  const lines = tail.split('\n');
  lines.pop();
  for (let i = lines.length - 1; i >= 0 && remaining.size; i--) {
    const line = lines[i];
    if (!line || Buffer.byteLength(line) > 65536) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (
        !object(row) ||
        !object(row.mcpCallControl) ||
        typeof row.mcpCallControl.controlId !== 'string'
      )
        continue;
      const current = remaining.get(row.mcpCallControl.controlId);
      if (!current) continue;
      const observation = matchingObservation(row, current, now);
      if (observation) {
        result.set(current.controlId, observation);
        remaining.delete(current.controlId);
      }
    } catch {}
  }
  return result;
}
function matchingObservation(
  row: Record<string, unknown>,
  current: McpCallControlCurrent,
  now: number,
): McpCallControlInspection['observation'] | null {
  if (
    !Number.isSafeInteger(row.seq) ||
    (row.seq as number) < 1 ||
    typeof row.ts !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.ts) ||
    new Date(row.ts).toISOString() !== row.ts ||
    Date.parse(row.ts) > now + 300000 ||
    Date.parse(row.ts) < Date.parse(current.at) ||
    !sha(row.hash) ||
    !sha(row.prevHash) ||
    row.hash !== hashEntry(row as never) ||
    row.phase !== 'pre' ||
    !object(row.decision) ||
    row.decision.effect !== 'deny' ||
    !object(row.mcpCallControl)
  )
    return null;
  const m = row.mcpCallControl;
  if (
    Object.keys(m).sort().join() !==
      ['controlId', 'eventId', 'invocationSha256', 'authoritySha256', 'reason'].sort().join() ||
    m.controlId !== current.controlId ||
    m.eventId !== current.eventId ||
    m.invocationSha256 !== current.invocationSha256 ||
    !sha(m.authoritySha256) ||
    !['paused', 'unavailable', 'busy'].includes(m.reason as string) ||
    row.decision.ruleId !== `mcp-call-control-${m.reason}` ||
    (m.reason === 'paused' && current.mode !== 'paused')
  )
    return null;
  return {
    status: 'observed',
    at: row.ts,
    eventId: current.eventId,
    invocationSha256: current.invocationSha256,
    reason: m.reason as 'paused' | 'unavailable' | 'busy',
  };
}
export async function readMcpCallControlObservation(
  home: string,
  current: McpCallControlCurrent | null,
  now: number,
): Promise<McpCallControlInspection['observation']> {
  if (!current) return empty('unobserved');
  return (await readMcpCallControlObservations(home, [current], now)).get(current.controlId)!;
}
