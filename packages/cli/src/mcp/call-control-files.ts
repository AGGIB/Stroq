import { createCallControlLeaseRunner, type CallControlLease } from './call-control-lease.js';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  type BigIntStats,
} from 'node:fs';
import { mkdir, open, readdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { mcpCallControlsDirIn } from '../paths.js';
import { readStateMacKeySync } from '../state-mac.js';
import {
  callControlError,
  MCP_CALL_CONTROL_ERRORS,
  MCP_CALL_CONTROL_LIMITS as LIMIT,
  type McpCallControlSnapshot,
} from './call-control-types.js';
import {
  callControlDigest,
  missingCallControlState,
  parseCallControlState,
} from './call-control-state.js';

const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === 'ENOENT';
const finite = (e: unknown): e is Error =>
  e instanceof Error && MCP_CALL_CONTROL_ERRORS.some((code) => code === e.message);
export function callControlFileError(e: unknown): never {
  if (finite(e)) throw e;
  return callControlError('mcp-call-control-unavailable');
}
const owned = (s: BigIntStats): boolean =>
  process.getuid === undefined || s.uid === BigInt(process.getuid());
const pin = (s: BigIntStats): string =>
  [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(':');
const dirPin = (s: BigIntStats): string => [s.dev, s.ino, s.mode, s.uid, s.gid].join(':');
function privateDir(path: string): BigIntStats {
  const s = lstatSync(path, { bigint: true });
  if (!s.isDirectory() || s.isSymbolicLink() || !owned(s) || (s.mode & 0o077n) !== 0n)
    callControlError('mcp-call-control-unavailable');
  return s;
}
function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch (e) {
    if (!missing(e)) throw e;
  }
  const parent = dirname(absolute);
  if (parent === absolute) return callControlError('mcp-call-control-unavailable');
  return join(canonical(parent), absolute.slice(parent.length + 1));
}
export interface CallControlContext {
  readonly home: string;
  readonly directory: string;
  readonly identity: string;
  readonly homeBinding: string;
  /** The home's state key, or null when none has been made yet (`state-mac.ts`). */
  readonly key: Buffer | null;
}
function contextSync(home: string): CallControlContext | null {
  if (process.platform === 'win32') callControlError('mcp-call-control-unsupported');
  const selected = canonical(home);
  const directory = mcpCallControlsDirIn(selected);
  try {
    const identity = [dirPin(privateDir(selected)), dirPin(privateDir(directory))].join('/');
    if (realpathSync(directory) !== directory) callControlError('mcp-call-control-unavailable');
    return {
      home: selected,
      directory,
      identity,
      homeBinding: callControlDigest(JSON.stringify([selected, identity])),
      key: readStateMacKeySync(selected),
    };
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}
async function context(home: string, create: boolean): Promise<CallControlContext | null> {
  if (create) {
    const selected = canonical(home);
    await mkdir(selected, { mode: 0o700, recursive: true });
    privateDir(selected);
    await mkdir(mcpCallControlsDirIn(selected), { mode: 0o700 }).catch((e) => {
      if (e.code !== 'EEXIST') throw e;
    });
  }
  return contextSync(home);
}
export interface CallControlFile {
  readonly bytes: Buffer;
  readonly pin: string;
}
function readSafeFileSync(file: string, maxBytes: number): CallControlFile | null {
  let before: BigIntStats;
  try {
    before = lstatSync(file, { bigint: true });
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !owned(before) ||
    before.nlink !== 1n ||
    (before.mode & 0o077n) !== 0n
  )
    callControlError('mcp-call-control-unavailable');
  if (before.size > BigInt(maxBytes)) callControlError('mcp-call-control-limit');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (pin(opened) !== pin(before)) callControlError('mcp-call-control-unavailable');
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) callControlError('mcp-call-control-unavailable');
      offset += count;
    }
    if (
      readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 ||
      pin(fstatSync(fd, { bigint: true })) !== pin(opened) ||
      pin(lstatSync(file, { bigint: true })) !== pin(opened)
    )
      callControlError('mcp-call-control-unavailable');
    return { bytes, pin: pin(opened) };
  } finally {
    closeSync(fd);
  }
}
export interface CallControlAuthority {
  readonly state: McpCallControlSnapshot;
  readonly context: CallControlContext | null;
  readonly file: CallControlFile | null;
}
export function readCallControlAuthorityFileSync(home: string): CallControlAuthority {
  try {
    const c = contextSync(home);
    if (!c) return { state: missingCallControlState(), context: null, file: null };
    const file = readSafeFileSync(join(c.directory, 'history.json'), LIMIT.liveBytes);
    const after = contextSync(home);
    if (after?.identity !== c.identity || after.home !== c.home)
      callControlError('mcp-call-control-unavailable');
    return {
      // A history with no key to check it against was not written by this Stroq: it is not trusted.
      state: file ? verifiedState(file.bytes, c) : missingCallControlState(),
      context: c,
      file,
    };
  } catch (e) {
    return callControlFileError(e);
  }
}
/**
 * The structure and the home binding are checked first, so a copied or moved home still reads as
 * unavailable; then a history with no key to check it against is refused, because it was not written
 * by this Stroq.
 */
function verifiedState(bytes: Buffer, c: CallControlContext): McpCallControlSnapshot {
  const state = parseCallControlState(bytes, c.homeBinding, c.key);
  if (c.key === null) callControlError('mcp-call-control-invalid');
  return state;
}
export const readCallControlAuthoritySync = (home: string): McpCallControlSnapshot =>
  readCallControlAuthorityFileSync(home).state;
export const readCallControlAuthority = async (home: string): Promise<McpCallControlSnapshot> =>
  readCallControlAuthoritySync(home);

export type { CallControlLease } from './call-control-lease.js';
export const withCallControlLease = createCallControlLeaseRunner({
  contextSync,
  context,
  privateDir,
  readSafeFileSync,
  dirPin,
  callControlFileError,
});

async function quota(c: CallControlContext, reserve: number, adding = true): Promise<void> {
  const entries = await readdir(c.directory, { withFileTypes: true });
  if (entries.length > LIMIT.stages + 3) callControlError('mcp-call-control-limit');
  let total = 4096 + reserve;
  let stages = 0;
  for (const entry of entries) {
    if (entry.name === '.lock' || entry.name === '.reaper') {
      privateDir(join(c.directory, entry.name));
      continue;
    }
    if (
      entry.name !== 'history.json' &&
      !/^\.stage-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(entry.name)
    )
      callControlError('mcp-call-control-unavailable');
    if (entry.name.startsWith('.stage-')) stages++;
    const file = readSafeFileSync(join(c.directory, entry.name), LIMIT.totalBytes);
    if (!file) callControlError('mcp-call-control-unavailable');
    total += file.bytes.length;
    if (total > LIMIT.totalBytes) callControlError('mcp-call-control-limit');
  }
  if (stages + Number(adding) > LIMIT.stages || total > LIMIT.totalBytes)
    callControlError('mcp-call-control-limit');
}
export async function publishCallControlAuthority(
  home: string,
  before: CallControlAuthority,
  bytes: Buffer,
  lease: CallControlLease,
  beforeCommit?: () => Promise<void>,
  fault?: (stage: 'before-publish' | 'after-publish' | 'before-readback') => void | Promise<void>,
): Promise<McpCallControlSnapshot> {
  if (bytes.length > LIMIT.liveBytes) callControlError('mcp-call-control-limit');
  const c = before.context;
  if (!c) return callControlError('mcp-call-control-unavailable');
  const stage = join(c.directory, '.stage-' + randomUUID());
  let staged: CallControlFile | null = null;
  let publicationAttempted = false;
  let published = false;
  try {
    lease.assertCurrentSync();
    await quota(c, bytes.length);
    const handle = await open(
      stage,
      constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    staged = readSafeFileSync(stage, LIMIT.liveBytes);
    if (!staged || !staged.bytes.equals(bytes)) callControlError('mcp-call-control-unavailable');
    await beforeCommit?.();
    await fault?.('before-publish');
    await quota(c, 0, false);
    lease.assertCurrentSync();
    const current = readCallControlAuthorityFileSync(home);
    if (
      current.context?.identity !== c.identity ||
      current.context?.home !== c.home ||
      (current.file?.pin ?? null) !== (before.file?.pin ?? null) ||
      current.state.revision !== before.state.revision
    )
      callControlError('mcp-call-control-stale');
    const finalStage = readSafeFileSync(stage, LIMIT.liveBytes);
    if (!finalStage || finalStage.pin !== staged.pin || !finalStage.bytes.equals(bytes))
      callControlError('mcp-call-control-unavailable');
    publicationAttempted = true;
    renameSync(stage, join(c.directory, 'history.json'));
    published = true;
    await fault?.('after-publish');
    const directory = await open(
      c.directory,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    await fault?.('before-readback');
    lease.assertCurrentSync();
    const after = readCallControlAuthorityFileSync(home);
    if (after.context?.identity !== c.identity || !after.file?.bytes.equals(bytes))
      callControlError('mcp-call-control-write-unconfirmed');
    return after.state;
  } catch (e) {
    if (publicationAttempted) callControlError('mcp-call-control-write-unconfirmed');
    return callControlFileError(e);
  } finally {
    if (!published && staged) {
      try {
        lease.assertCurrentSync();
        const current = readSafeFileSync(stage, LIMIT.liveBytes);
        if (current?.pin === staged.pin && current.bytes.equals(staged.bytes)) await unlink(stage);
      } catch {
        /* Unknown files are never cleaned up. */
      }
    }
  }
}
