import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { parseStrictJson } from '../../packages/core/src/scope/strict-json.ts';
import { atomicWrite, rootIdentity, snapshotFile } from './agent-setup-files.mjs';
import {
  validateIncidentAssessmentState,
  type IncidentAssessmentRecord,
} from '../lib/incident-assessments.ts';
import {
  assessmentHash as hash,
  assessmentFail as fail,
  assessmentOwned as owned,
} from './incident-assessment-selector.ts';

const MAX = 512 * 1024,
  BUDGET = 1024 * 1024,
  RESERVE = 1024;
const stageName = /^\.stroq-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.tmp$/;
export type AssessmentFault = (
  stage: 'before-publish' | 'after-publish' | 'before-readback',
) => void | Promise<void>;
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const homeBinding = (home: string, snapshot: Awaited<ReturnType<typeof snapshotFile>>) => {
  const p = snapshot.directories.find((d) => d.path === home);
  return p ? hash(JSON.stringify(p)) : null;
};
async function capture(home: string) {
  let anchor = home;
  for (;;) {
    try {
      await lstat(anchor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(anchor) === anchor)
        throw error;
      anchor = dirname(anchor);
    }
  }
  const root = await rootIdentity(anchor);
  if (root.path !== anchor) fail('history-unavailable');
  const directory = join(home, 'console', 'incident-assessments'),
    path = join(directory, 'history.json'),
    snapshot = await snapshotFile(root, path, MAX);
  if (
    snapshot.directories.some(
      (d) =>
        !owned(d) ||
        (d.mode & 0o022) !== 0 ||
        ((d.path === home || d.path.startsWith(home + '/')) && (d.mode & 0o777) !== 0o700),
    ) ||
    (snapshot.file && (!owned(snapshot.file) || (snapshot.file.mode & 0o777) !== 0o600))
  )
    fail('history-unavailable');
  return { root, directory, path, snapshot, homeBinding: homeBinding(home, snapshot) };
}
export async function readAssessmentStore(home: string) {
  try {
    const value = await capture(home),
      records: IncidentAssessmentRecord[] = [];
    if (value.snapshot.bytes) {
      const parsed = parseStrictJson(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value.snapshot.bytes),
      );
      if (
        !parsed.ok ||
        !exact(parsed.value, ['schema', 'homeBinding', 'records']) ||
        parsed.value.schema !== 'stroq-incident-assessment-history/1' ||
        parsed.value.homeBinding !== value.homeBinding
      )
        fail('history-unavailable');
      const rows = (parsed as { ok: true; value: Record<string, unknown> }).value.records;
      const capacity = Array.isArray(rows) && rows.length === 512;
      const body = {
        schema: 'stroq-incident-assessments/1',
        scope: 'local-journal',
        generatedAt: '9999-12-31T23:59:59.999Z',
        history: 'ready',
        revision: value.snapshot.sha256,
        records: rows,
        canRecord: !capacity,
        error: capacity ? 'store-full' : null,
      };
      if (!validateIncidentAssessmentState(body)) fail('history-unavailable');
      records.push(...body.records);
    }
    let stages = 0,
      bytes = value.snapshot.bytes?.length ?? 0;
    try {
      const listing = await opendir(value.directory, { bufferSize: 4 });
      let count = 0;
      for await (const child of listing) {
        if (++count > 33 || !child.isFile()) fail('history-unavailable');
        if (child.name === 'history.json') continue;
        if (!stageName.test(child.name) || ++stages > 32) fail('history-unavailable');
        const staged = await snapshotFile(value.root, join(value.directory, child.name), MAX);
        if (
          !staged.file ||
          !staged.bytes ||
          !owned(staged.file) ||
          (staged.file.mode & 0o777) !== 0o600
        )
          fail('history-unavailable');
        bytes += staged.bytes.length;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (bytes > BUDGET) fail('history-unavailable');
    if (!same(value.snapshot, await snapshotFile(value.root, value.path, MAX)))
      fail('history-unavailable');
    const full =
      records.length >= 512 ||
      stages >= 32 ||
      (value.snapshot.bytes?.length ?? 0) + RESERVE > MAX ||
      bytes + (value.snapshot.bytes?.length ?? 0) + RESERVE > BUDGET;
    return {
      ...value,
      records,
      revision: value.snapshot.bytes ? value.snapshot.sha256 : null,
      stages,
      bytes,
      full,
    };
  } catch {
    fail('history-unavailable');
  }
}
export type AssessmentStore = Awaited<ReturnType<typeof readAssessmentStore>>;
export async function assertAssessmentStore(home: string, before: AssessmentStore) {
  const fresh = await readAssessmentStore(home);
  if (
    fresh.revision !== before.revision ||
    fresh.homeBinding !== before.homeBinding ||
    !same(fresh.snapshot.file, before.snapshot.file) ||
    !before.snapshot.directories.every((d, i) => same(d, fresh.snapshot.directories[i]))
  )
    fail('stale-assessment');
  return fresh;
}
async function sync(directory: string) {
  const before = await rootIdentity(directory),
    handle = await open(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (info.dev !== before.dev || info.ino !== before.ino) fail('write-unconfirmed');
    await handle.sync();
    if (!same(before, await rootIdentity(directory))) fail('write-unconfirmed');
  } finally {
    await handle.close();
  }
}
/** Explicit apply only. Reads never create parents or acquire leases. */
export async function initializeAssessmentStore(home: string, before: AssessmentStore) {
  if (!before.homeBinding) fail('history-unavailable');
  await assertAssessmentStore(home, before);
  for (const path of [join(home, 'console'), before.directory]) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await assertAssessmentStore(home, before);
    await sync(dirname(path));
  }
  return assertAssessmentStore(home, before);
}
export async function appendAssessmentRecord(
  home: string,
  before: AssessmentStore,
  record: IncidentAssessmentRecord,
  guard: () => Promise<void>,
  fault?: AssessmentFault,
) {
  const bytes = Buffer.from(
    JSON.stringify({
      schema: 'stroq-incident-assessment-history/1',
      homeBinding: before.homeBinding,
      records: [...before.records, record],
    }) + '\n',
  );
  const fresh = await assertAssessmentStore(home, before);
  if (fresh.full || bytes.length > MAX || fresh.bytes + bytes.length > BUDGET) fail('store-full');
  let possiblePublication = false;
  try {
    const published = await atomicWrite(fresh.root, fresh.path, bytes, fresh.snapshot, 0o600, {
      fault: async (stage?: string) => {
        if (stage === 'before-rename') {
          await fault?.('before-publish');
          await guard();
          await assertAssessmentStore(home, before);
          possiblePublication = true;
        }
        if (stage === 'after-rename') {
          possiblePublication = true;
          await fault?.('after-publish');
        }
      },
    });
    await sync(fresh.directory);
    await fault?.('before-readback');
    const after = await readAssessmentStore(home);
    if (
      after.revision !== hash(bytes) ||
      !after.snapshot.bytes?.equals(bytes) ||
      !same(after.snapshot.file, published.file) ||
      after.homeBinding !== before.homeBinding
    )
      fail('write-unconfirmed');
    return after;
  } catch (error) {
    if (possiblePublication) fail('write-unconfirmed');
    throw error;
  }
}
