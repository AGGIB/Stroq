import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const uid = typeof process.getuid === 'function' ? process.getuid() : null;
const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code) => {
  throw new Error(code);
};
const owned = (stat) => uid === null || stat.uid === uid;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

async function directory(path, privateMode = false) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    !owned(stat) ||
    (stat.mode & 0o022) !== 0 ||
    (privateMode && (stat.mode & 0o777) !== 0o700) ||
    (await realpath(path)) !== path
  )
    fail('unsafe-path');
  return stat;
}

/** Pin the nearest existing owned directory without creating anything during a read. */
async function location(root) {
  let at = root;
  const missing = [];
  for (;;) {
    try {
      const stat = await directory(at);
      let consoleStat = null;
      if (missing.length === 0) {
        try {
          consoleStat = await directory(join(root, 'console'), true);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      return { anchor: at, anchorStat: stat, missing, consoleStat };
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(at) === at) throw error;
      missing.unshift(at);
      at = dirname(at);
    }
  }
}

function unchangedLocation(before, after) {
  return (
    before.anchor === after.anchor &&
    same(before.anchorStat, after.anchorStat) &&
    before.missing.join('\u0000') === after.missing.join('\u0000') &&
    (before.consoleStat === null || after.consoleStat === null
      ? before.consoleStat === after.consoleStat
      : same(before.consoleStat, after.consoleStat))
  );
}

async function assertLocation(root, before) {
  if (!unchangedLocation(before, await location(root))) fail('unsafe-path');
}

/** Other console actions may create an initially absent Stroq home/console first. */
async function adoptLocation(root, before) {
  if (!same(await directory(before.anchor), before.anchorStat)) fail('unsafe-path');
  for (const path of before.missing) {
    try {
      await directory(path, true);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  const current = await location(root);
  if (current.anchor !== before.anchor && !before.missing.includes(current.anchor))
    fail('unsafe-path');
  if (
    current.missing.length > before.missing.length ||
    current.missing.join('\u0000') !==
      before.missing.slice(before.missing.length - current.missing.length).join('\u0000')
  )
    fail('unsafe-path');
  if (
    before.consoleStat !== null &&
    (current.consoleStat === null || !same(before.consoleStat, current.consoleStat))
  )
    fail('unsafe-path');
  return current;
}

async function createLocation(root, before) {
  await assertLocation(root, before);
  for (const path of before.missing) {
    await mkdir(path, { mode: 0o700 });
    await directory(path, true);
  }
  if (before.consoleStat === null) await mkdir(join(root, 'console'), { mode: 0o700 });
  return location(root);
}

function regular(stat) {
  return stat.isFile() && owned(stat) && stat.nlink === 1 && (stat.mode & 0o777) === 0o600;
}

/** Bound bytes before reading and verify the opened inode, named file and parent identities. */
async function readBytes(root, pinned, filename) {
  await assertLocation(root, pinned);
  if (pinned.consoleStat === null) return null;
  const path = join(root, 'console', filename);
  let handle;
  try {
    let before;
    try {
      before = await lstat(path);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (!regular(before)) fail('unsafe-path');
    if (before.size > MAX_HISTORY_BYTES) fail('invalid-history');
    handle = await open(path, flags);
    const stat = await handle.stat();
    if (!regular(stat) || !same(stat, before)) fail('unsafe-path');
    if (stat.size > MAX_HISTORY_BYTES) fail('invalid-history');
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    const named = await lstat(path);
    if (
      bytesRead !== bytes.length ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      !same(stat, named) ||
      !regular(named)
    )
      fail('read-failed');
    await assertLocation(root, pinned);
    return bytes;
  } finally {
    await handle?.close();
  }
}

function validRuns(runs, validateRun, workspaceId) {
  return (
    Array.isArray(runs) &&
    runs.length <= 32 &&
    runs.every(validateRun) &&
    runs.every(
      (run) => run.provenance === undefined || run.provenance.workspaceId === workspaceId,
    ) &&
    new Set(runs.map((run) => run.id)).size === runs.length &&
    runs.filter((run) => run.status === 'running').length <= 1
  );
}

function parse(bytes, validateRun, workspaceId, parseHistory = JSON.parse) {
  if (bytes === null) return [];
  try {
    const value = parseHistory(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (
      !plain(value) ||
      Object.keys(value).length !== 3 ||
      value.schema !== 'stroq-runs/2' ||
      value.workspaceId !== workspaceId ||
      !validRuns(value.runs, validateRun, workspaceId)
    )
      fail('invalid-history');
    return value.runs;
  } catch {
    fail('invalid-history');
  }
}

/**
 * Atomic replacement of one fixed private file. Revision checks also refuse stale writers.
 * Portable filesystems do not offer a compare-and-swap rename against a same-user race.
 */
async function writeBytes(root, pinned, revision, bytes, filename) {
  const current = await readBytes(root, pinned, filename);
  if ((current === null ? null : hash(current)) !== revision) fail('write-failed');
  const path = join(root, 'console', filename);
  const temporary = join(root, 'console', `.runs-${randomUUID()}.tmp`);
  let handle;
  let staged = false;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    staged = true;
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = null;
    const latest = await readBytes(root, pinned, filename);
    if ((latest === null ? null : hash(latest)) !== revision) fail('write-failed');
    await assertLocation(root, pinned);
    await rename(temporary, path);
    staged = false;
    let dirHandle;
    try {
      dirHandle = await open(join(root, 'console'), flags);
      if (!same(await dirHandle.stat(), pinned.consoleStat)) fail('unsafe-path');
      await dirHandle.sync();
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
    } finally {
      await dirHandle?.close();
    }
  } finally {
    await handle?.close();
    if (staged) {
      // Do not follow a substituted parent while cleaning up a staged file.
      try {
        await assertLocation(root, pinned);
        await unlink(temporary);
      } catch {
        /* Leave unsafe cleanup alone. */
      }
    }
  }
}

/** Stores only validated derived reports. Broken/unsafe history is never overwritten. */
export async function createRunStore({
  home,
  workspaceId,
  namespace = 'runs',
  loadValidator = () => import('../.local-engine/control-schema.js'),
} = {}) {
  let state = { status: home === undefined ? 'disabled' : 'ready' };
  let runs = [];
  let pinned;
  let revision = null;
  let validateRun;
  let parseHistory;
  const root = home === undefined ? null : resolve(home);
  const filename = `${namespace}-${workspaceId}.json`;
  const setError = (error) => {
    state = { status: 'error', error };
  };
  if (root !== null) {
    try {
      if (
        !['runs', 'hook-checks', 'workspace-review', 'codex-network-checks'].includes(namespace) ||
        typeof workspaceId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(workspaceId)
      )
        throw new Error('unavailable');
      ({ validateRun, parseHistory } = await loadValidator());
      if (
        typeof validateRun !== 'function' ||
        (parseHistory !== undefined && typeof parseHistory !== 'function')
      )
        throw new Error('unavailable');
    } catch {
      setError('unavailable');
    }
    if (state.status === 'ready') {
      try {
        pinned = await location(root);
        const bytes = await readBytes(root, pinned, filename);
        runs = parse(bytes, validateRun, workspaceId, parseHistory);
        revision = bytes === null ? null : hash(bytes);
      } catch (error) {
        setError(
          ['unsafe-path', 'invalid-history'].includes(error.message)
            ? error.message
            : 'read-failed',
        );
      }
    }
  }
  return {
    runs: structuredClone(runs),
    state: () => ({ ...state }),
    /** Passive reread retains the first physical parent binding and updates only this reader's CAS. */
    async refresh() {
      if (state.status !== 'ready') return null;
      try {
        pinned = await adoptLocation(root, pinned);
        const bytes = await readBytes(root, pinned, filename);
        runs = parse(bytes, validateRun, workspaceId, parseHistory);
        revision = bytes === null ? null : hash(bytes);
        return structuredClone(runs);
      } catch (error) {
        setError(
          ['unsafe-path', 'invalid-history'].includes(error.message)
            ? error.message
            : 'read-failed',
        );
        return null;
      }
    },
    /** Explicit admission only: lease parents may be prepared without rewriting history. */
    async prepare() {
      if (state.status !== 'ready') return false;
      try {
        pinned = await adoptLocation(root, pinned);
        if (pinned.missing.length || pinned.consoleStat === null)
          pinned = await createLocation(root, pinned);
        await assertLocation(root, pinned);
        return true;
      } catch (error) {
        setError(error.message === 'unsafe-path' ? 'unsafe-path' : 'write-failed');
        return false;
      }
    },
    async write(next) {
      if (state.status !== 'ready') return false;
      try {
        if (!validRuns(next, validateRun, workspaceId)) fail('write-failed');
        const bytes = Buffer.from(
          `${JSON.stringify({ schema: 'stroq-runs/2', workspaceId, runs: next })}\n`,
        );
        if (bytes.length > MAX_HISTORY_BYTES) fail('write-failed');
        if (pinned.missing.length || pinned.consoleStat === null) {
          pinned = await adoptLocation(root, pinned);
          if (pinned.missing.length || pinned.consoleStat === null)
            pinned = await createLocation(root, pinned);
        }
        await writeBytes(root, pinned, revision, bytes, filename);
        revision = hash(bytes);
        return true;
      } catch (error) {
        setError(error.message === 'unsafe-path' ? 'unsafe-path' : 'write-failed');
        return false;
      }
    },
  };
}
