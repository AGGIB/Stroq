import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { readRegularFile } from '../util/read-regular-file.js';
import { isTaskId } from './types.js';

/**
 * Where a task's permit lives, and the one strict reader of it:
 *
 *   <home>/tasks/<taskId>/permit.json              the signed permit
 *   <home>/tasks/<taskId>/revoked, ended           markers: their existence is the message
 *   <home>/tasks/<taskId>/extensions/<fp>.json     a signed escalation for one operation
 *   <home>/tasks/<taskId>/extensions/<fp>.<h>.used the escalation whose bytes hash to <h> was used
 *
 * The reader returns a typed result and never throws, because it runs inside a hook: an
 * exception there is a crashed hook, which the host may read as "no objection". Everything
 * that is not plainly a regular file of a sane size is `void`, and void means deny.
 */

export const MAX_PERMIT_FILE_BYTES = 64 * 1024;
export const MAX_ESCALATION_FILE_BYTES = 16 * 1024;

export type StoreVoidReason =
  | 'bad-task-id'
  | 'bad-fingerprint'
  | 'revoked'
  | 'ended'
  | 'used'
  | 'not-regular'
  | 'oversize'
  | 'unreadable'
  | 'task-dir';

export type StoreRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly text: string }
  | { readonly kind: 'void'; readonly reason: StoreVoidReason };

/** What the gate needs of a store: a fake one in a test, the files on disk in a hook. */
export interface PermitStore {
  readPermit(taskId: string): StoreRead;
  readEscalation(taskId: string, fingerprint: string): StoreRead;
  /** Records that this escalation (these exact bytes) was used. False if it already was, or cannot be. */
  consumeEscalation(taskId: string, fingerprint: string, text: string): boolean;
}

const FINGERPRINT = /^[0-9a-f]{64}$/;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const CREATE_NEW =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

type Found = 'absent' | 'present' | 'symlink' | 'unreadable';

/** What is at `path`, without following a link. */
function lookup(path: string): { found: Found; isFile: boolean; isDirectory: boolean } {
  try {
    const stats = lstatSync(path);
    return {
      found: stats.isSymbolicLink() ? 'symlink' : 'present',
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
    };
  } catch (err) {
    const found =
      (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'absent' : 'unreadable';
    return { found, isFile: false, isDirectory: false };
  }
}

const hashOf = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

function createFile(path: string, data: string): void {
  const fd = openSync(path, CREATE_NEW, PRIVATE_FILE_MODE);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

export interface FilePermitStoreOptions {
  /** The Stroq home. Always given, so that a test never reads or writes the real one. */
  readonly home: string;
}

export class FilePermitStore implements PermitStore {
  private readonly tasks: string;

  constructor(options: FilePermitStoreOptions) {
    this.tasks = join(options.home, 'tasks');
  }

  /**
   * `void` for a task directory that is not a plain directory, or a revoked or ended task;
   * null when the task is simply absent or in good standing.
   */
  private standing(dir: string): StoreRead | null {
    const state = lookup(dir);
    if (state.found === 'absent') return { kind: 'absent' };
    if (state.found !== 'present' || !state.isDirectory) {
      return { kind: 'void', reason: state.found === 'unreadable' ? 'unreadable' : 'task-dir' };
    }
    for (const marker of ['revoked', 'ended'] as const) {
      const mark = lookup(join(dir, marker));
      if (mark.found === 'unreadable') return { kind: 'void', reason: 'unreadable' };
      if (mark.found !== 'absent') return { kind: 'void', reason: marker };
    }
    return null;
  }

  private readFile(path: string, maxBytes: number): StoreRead {
    const state = lookup(path);
    if (state.found === 'absent') return { kind: 'absent' };
    if (state.found === 'unreadable') return { kind: 'void', reason: 'unreadable' };
    if (state.found === 'symlink' || !state.isFile) return { kind: 'void', reason: 'not-regular' };
    try {
      const read = readRegularFile(path, maxBytes, { noFollow: true });
      if (read.kind === 'text') return { kind: 'present', text: read.text };
      return { kind: 'void', reason: read.kind === 'too-large' ? 'oversize' : 'not-regular' };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') return { kind: 'absent' };
      return { kind: 'void', reason: code === 'ELOOP' ? 'not-regular' : 'unreadable' };
    }
  }

  readPermit(taskId: string): StoreRead {
    if (!isTaskId(taskId)) return { kind: 'void', reason: 'bad-task-id' };
    const dir = join(this.tasks, taskId);
    const standing = this.standing(dir);
    if (standing !== null) return standing;
    return this.readFile(join(dir, 'permit.json'), MAX_PERMIT_FILE_BYTES);
  }

  readEscalation(taskId: string, fingerprint: string): StoreRead {
    if (!isTaskId(taskId)) return { kind: 'void', reason: 'bad-task-id' };
    if (!FINGERPRINT.test(fingerprint)) return { kind: 'void', reason: 'bad-fingerprint' };
    const dir = join(this.tasks, taskId);
    const standing = this.standing(dir);
    if (standing !== null) return standing;
    const file = this.readFile(
      join(dir, 'extensions', `${fingerprint}.json`),
      MAX_ESCALATION_FILE_BYTES,
    );
    if (file.kind !== 'present') return file;
    const used = lookup(this.usedMarker(dir, fingerprint, file.text));
    return used.found === 'absent' ? file : { kind: 'void', reason: 'used' };
  }

  consumeEscalation(taskId: string, fingerprint: string, text: string): boolean {
    if (!isTaskId(taskId) || !FINGERPRINT.test(fingerprint)) return false;
    try {
      createFile(this.usedMarker(join(this.tasks, taskId), fingerprint, text), '');
      return true;
    } catch {
      // Already used, or the marker cannot be written: either way, no second use.
      return false;
    }
  }

  private usedMarker(dir: string, fingerprint: string, text: string): string {
    return join(dir, 'extensions', `${fingerprint}.${hashOf(text)}.used`);
  }

  // The writers below are for the commands that issue and end tasks. They throw on a bad
  // argument or a failed write, because their callers are people at a terminal who need to
  // be told; the reader above is the only part that runs inside a hook.

  private taskDir(taskId: string): string {
    if (!isTaskId(taskId)) throw new Error('permit store: not a valid task id');
    return join(this.tasks, taskId);
  }

  /** Writes the permit. Never replaces one: a second permit for a task is a different task. */
  writePermit(taskId: string, text: string): void {
    const dir = this.taskDir(taskId);
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    try {
      createFile(join(dir, 'permit.json'), text);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code === 'EEXIST') {
        throw new Error('permit store: a permit already exists for this task');
      }
      throw err;
    }
  }

  /** Writes an escalation, replacing an earlier one for the same operation, atomically. */
  writeEscalation(taskId: string, fingerprint: string, text: string): void {
    const dir = join(this.taskDir(taskId), 'extensions');
    if (!FINGERPRINT.test(fingerprint)) throw new Error('permit store: not a valid fingerprint');
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    const temp = join(dir, `${fingerprint}.${randomBytes(6).toString('hex')}.tmp`);
    createFile(temp, text);
    renameSync(temp, join(dir, `${fingerprint}.json`));
  }

  private mark(taskId: string, marker: 'revoked' | 'ended'): void {
    const dir = this.taskDir(taskId);
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    try {
      createFile(join(dir, marker), '');
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw err;
    }
  }

  revoke(taskId: string): void {
    this.mark(taskId, 'revoked');
  }

  end(taskId: string): void {
    this.mark(taskId, 'ended');
  }
}
