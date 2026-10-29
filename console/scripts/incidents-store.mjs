import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readIncidentFile, safeDirectory, sameFile } from './incidents-safe.mjs';

const MAX_RECORDS = 1000;
const MAX_BYTES = 512 * 1024;
const RETENTION = 90 * 24 * 3600_000;
const ID = /^incident-[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{64}$/;
const queues = new Map();
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (v, keys) => object(v) && Object.keys(v).every((key) => keys.includes(key));

export function validIncidentTime(time, now) {
  if (typeof time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time))
    return false;
  const stamp = Date.parse(time);
  return Number.isFinite(stamp) && new Date(stamp).toISOString() === time && stamp <= now + 300_000;
}

export function validateReviewRequest(request) {
  if (
    !only(request, ['id', 'expectedEvidenceSha', 'status']) ||
    !ID.test(request.id) ||
    !SHA.test(request.expectedEvidenceSha) ||
    !['reviewed', 'open'].includes(request.status)
  )
    throw new Error('invalid-request');
}

export async function readReviews(home, now) {
  const file = await readIncidentFile(home, ['console', 'incident-reviews.json'], MAX_BYTES, {
    privateMode: true,
  });
  if (file.kind === 'missing') return { records: [], revision: null };
  try {
    if (file.kind !== 'text') throw new Error();
    const raw = JSON.parse(file.text);
    if (
      !only(raw, ['schema', 'records']) ||
      raw.schema !== 'stroq-incident-reviews/1' ||
      !Array.isArray(raw.records) ||
      raw.records.length > MAX_RECORDS
    )
      throw new Error();
    const seen = new Set();
    for (const row of raw.records) {
      if (
        !only(row, ['id', 'evidenceSha', 'status', 'reviewedAt']) ||
        !ID.test(row.id) ||
        !SHA.test(row.evidenceSha) ||
        row.id !== `incident-${row.evidenceSha}` ||
        row.status !== 'reviewed' ||
        !validIncidentTime(row.reviewedAt, now) ||
        seen.has(row.id)
      )
        throw new Error();
      seen.add(row.id);
    }
    return {
      records: raw.records.filter((row) => now - Date.parse(row.reviewedAt) <= RETENTION),
      revision: file.revision,
    };
  } catch {
    throw new Error('review-unavailable');
  }
}

/** Serializes console instances; other processes use an exclusive fixed lock, with no stale-lock guessing. */
export function writeReview(home, request, now, recheck) {
  const previous = queues.get(home) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => updateReview(home, request, now, recheck));
  queues.set(home, current);
  void current
    .finally(() => {
      if (queues.get(home) === current) queues.delete(home);
    })
    .catch(() => undefined);
  return current;
}

async function updateReview(home, request, now, recheck) {
  const rootStat = await safeDirectory(home).catch(() => {
    throw new Error('review-unavailable');
  });
  const store = join(home, 'console');
  try {
    await mkdir(store, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw new Error('review-unavailable');
  }
  const storeStat = await safeDirectory(store, true).catch(() => {
    throw new Error('review-unavailable');
  });
  const lock = join(store, '.incident-reviews.lock');
  let lockHandle;
  try {
    lockHandle = await open(lock, 'wx', 0o600);
  } catch (error) {
    throw new Error(error.code === 'EEXIST' ? 'busy' : 'review-unavailable');
  }
  const lockStat = await lockHandle.stat();
  let temp;
  try {
    await lockHandle.writeFile(
      JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }),
    );
    const old = await readReviews(home, now);
    await recheck();
    const records = old.records.filter((row) => row.id !== request.id);
    const row = {
      id: request.id,
      evidenceSha: request.expectedEvidenceSha,
      status: request.status,
      reviewedAt: request.status === 'reviewed' ? new Date(now).toISOString() : null,
    };
    if (request.status === 'reviewed') records.push(row);
    records.sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt));
    const bytes = Buffer.from(
      JSON.stringify({ schema: 'stroq-incident-reviews/1', records: records.slice(-MAX_RECORDS) }),
    );
    temp = join(store, `.incident-reviews-${randomUUID()}.tmp`);
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await recheck();
    if (
      !sameFile(await safeDirectory(home), rootStat) ||
      !sameFile(await safeDirectory(store, true), storeStat)
    )
      throw new Error('review-unavailable');
    const current = await readReviews(home, now);
    if (current.revision !== old.revision) throw new Error('review-unavailable');
    await rename(temp, join(store, 'incident-reviews.json'));
    temp = undefined;
    return row;
  } catch (error) {
    if (['stale-evidence', 'review-unavailable'].includes(error?.message)) throw error;
    throw new Error('review-unavailable');
  } finally {
    if (temp) await unlink(temp).catch(() => undefined);
    await lockHandle.close();
    const current = await lstat(lock).catch(() => null);
    if (current && sameFile(current, lockStat)) await unlink(lock).catch(() => undefined);
  }
}
