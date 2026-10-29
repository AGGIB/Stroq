import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseStrictJson } from '../../packages/core/src/scope/strict-json.ts';
import { rootIdentity } from './agent-setup-files.mjs';
import {
  validateIncidentAssessmentBinding,
  type IncidentAssessmentBinding,
} from '../lib/incident-assessments.ts';

export const assessmentHash = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export function assessmentFail(code: string): never {
  throw new Error(code);
}
export const assessmentOwned = (v: { uid: number }) =>
  typeof process.getuid !== 'function' || v.uid === process.getuid();
const pin = (s: {
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  size: number;
  nlink: number;
  mtimeMs: number;
  ctimeMs: number;
}) => ({
  dev: s.dev,
  ino: s.ino,
  uid: s.uid,
  mode: s.mode,
  size: s.size,
  nlink: s.nlink,
  mtimeMs: s.mtimeMs,
  ctimeMs: s.ctimeMs,
});
export type AssessmentSource = {
  root: Awaited<ReturnType<typeof rootIdentity>>;
  pin: ReturnType<typeof pin>;
  offset: number;
  bytes: number;
  sha256: string;
  incident: IncidentAssessmentBinding;
};
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const iso = (v: unknown): v is string =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const SHA = /^[a-f0-9]{64}$/;
async function range(handle: Awaited<ReturnType<typeof open>>, offset: number, bytes: number) {
  const result = Buffer.alloc(bytes);
  let filled = 0;
  while (filled < bytes) {
    const read = await handle.read(result, filled, bytes - filled, offset + filled);
    if (!read.bytesRead) assessmentFail('stale-evidence');
    filled += read.bytesRead;
  }
  return result;
}
/** Exact bounded raw-line selection. No journal text or native session identifier leaves this function. */
export async function selectAssessmentIncident(
  home: string,
  input: { id: string; expectedEvidenceSha: string },
  now: number,
  expected?: AssessmentSource,
): Promise<AssessmentSource> {
  let handle;
  try {
    const root = await rootIdentity(home);
    if (root.path !== home || !assessmentOwned(root) || (root.mode & 0o022) !== 0)
      assessmentFail('stale-evidence');
    const path = join(home, 'audit.jsonl'),
      before = await lstat(path);
    const safe = (s: typeof before) =>
      s.isFile() &&
      s.nlink === 1 &&
      assessmentOwned(s) &&
      (s.mode & 0o022) === 0 &&
      Number.isSafeInteger(s.size);
    if (!safe(before) || (await realpath(path)) !== path) assessmentFail('stale-evidence');
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const first = await handle.stat();
    if (!safe(first) || !isDeepStrictEqual(pin(first), pin(before)))
      assessmentFail('stale-evidence');
    if (expected) {
      if (
        !isDeepStrictEqual(root, expected.root) ||
        first.size < expected.pin.size ||
        !(['dev', 'ino', 'uid', 'mode', 'nlink'] as const).every(
          (k) => first[k] === expected.pin[k],
        ) ||
        (first.size === expected.pin.size && !isDeepStrictEqual(pin(first), expected.pin))
      )
        assessmentFail('stale-evidence');
      if (assessmentHash(await range(handle, expected.offset, expected.bytes)) !== expected.sha256)
        assessmentFail('stale-evidence');
    }
    const offset = Math.max(0, first.size - 1024 * 1024),
      bytes = await range(handle, offset, first.size - offset);
    let selected = bytes;
    if (offset) {
      const newline = bytes.indexOf(10);
      if (newline < 0) assessmentFail('stale-evidence');
      selected = bytes.subarray(newline + 1);
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(selected),
      lines = text.split('\n');
    lines.pop();
    let incident: IncidentAssessmentBinding | null = null;
    for (const raw of lines) {
      if (assessmentHash(raw) !== input.expectedEvidenceSha) continue;
      if (Buffer.byteLength(raw) > 512 * 1024) assessmentFail('stale-evidence');
      const parsed = parseStrictJson(raw);
      if (!parsed.ok || !object(parsed.value)) assessmentFail('stale-evidence');
      const row = (parsed as { ok: true; value: Record<string, unknown> }).value;
      if (
        Object.hasOwn(row, 'outcome') ||
        !Number.isSafeInteger(row.seq) ||
        Number(row.seq) < 1 ||
        !iso(row.ts) ||
        Date.parse(row.ts) > now + 300000 ||
        typeof row.sessionId !== 'string' ||
        !row.sessionId.length ||
        row.sessionId.length > 512 ||
        /[\ud800-\udfff]/u.test(row.sessionId) ||
        typeof row.hash !== 'string' ||
        !SHA.test(row.hash) ||
        typeof row.prevHash !== 'string' ||
        !SHA.test(row.prevHash)
      )
        assessmentFail('stale-evidence');
      const kind =
        row.phase === 'pre' &&
        object(row.decision) &&
        ['deny', 'ask'].includes(String(row.decision.effect))
          ? `policy-${row.decision.effect}`
          : row.phase === 'post' &&
              object(row.scan) &&
              row.scan.verdict === 'suspect' &&
              typeof row.scan.score === 'number' &&
              Number.isFinite(row.scan.score) &&
              row.scan.score >= 0 &&
              row.scan.score <= 1
            ? 'content-flag'
            : null;
      const binding = {
        id: input.id,
        evidenceSha256: input.expectedEvidenceSha,
        sequence: Number(row.seq),
        recordedAt: String(row.ts),
        kind,
      };
      if (incident || !validateIncidentAssessmentBinding(binding)) assessmentFail('stale-evidence');
      incident = binding;
    }
    if (
      !incident ||
      !isDeepStrictEqual(pin(first), pin(await handle.stat())) ||
      !isDeepStrictEqual(pin(first), pin(await lstat(path))) ||
      !isDeepStrictEqual(root, await rootIdentity(home))
    )
      assessmentFail('stale-evidence');
    if (expected && !isDeepStrictEqual(incident, expected.incident))
      assessmentFail('stale-evidence');
    return {
      root,
      pin: pin(first),
      offset,
      bytes: bytes.length,
      sha256: assessmentHash(bytes),
      incident,
    };
  } catch {
    return assessmentFail('stale-evidence');
  } finally {
    await handle?.close();
  }
}
