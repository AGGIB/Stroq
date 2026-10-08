import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

/**
 * Reading one script file: through one descriptor, so that what is checked is what is read, with
 * a limit on its size, and as the shell that runs it reads the bytes.
 */

export const MAX_SCRIPT_BYTES = 1024 * 1024;
const SHEBANG_BYTES = 128;
/** `#!/bin/bash`, `#!/usr/bin/env -S bash -e`: a file that says it is a shell script. */
const SHELL_SHEBANG = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(?:ba|z|da|k|fi)?sh\b/;

export type ScriptRead =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'too-large' }
  /** There, and not readable: `sudo bash x.sh` reads what this could not. */
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'none' };

/**
 * `O_NONBLOCK` so that opening a FIFO named like a script returns at once instead of
 * waiting for a writer that never comes: a hook has one thread, and a host that times it
 * out treats that as an allow. The handle is then refused below as not a regular file.
 * Windows defines no such constant, and 0 leaves the open as it was.
 */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/** Errors that mean there is no such file, as opposed to one that could not be read. */
const NO_SUCH_FILE: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'ELOOP']);

/**
 * A script's bytes as the shell that runs it reads them. A UTF-16 file with a byte-order
 * mark is what Windows PowerShell 5 writes by default, and decoding it as UTF-8 leaves a NUL
 * between every letter, so the commands in it read as nothing. Past the first line, bash,
 * dash and zsh drop a NUL and carry on, so one is stripped rather than taken for the sign
 * of a binary; a file bash would refuse to run is read as if it ran, which can only add
 * a danger. A UTF-8 byte-order mark is dropped, so it does not stick to the first word.
 */
function decodeScript(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le', 2);
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const even = buffer.length - ((buffer.length - 2) % 2);
    return Buffer.from(buffer.subarray(2, even)).swap16().toString('utf16le');
  }
  const text = buffer.toString('utf8');
  return (text.includes('\0') ? text.replaceAll('\0', '') : text).replace(/^\uFEFF/, '');
}

/**
 * The script's text, read through one descriptor: what is checked (a regular file, its
 * size, a shell `#!` line) is what is read, so a file swapped between a check and a read is
 * not a way around either.
 */
export function readScript(path: string, needsShebang: boolean): ScriptRead {
  let fd: number | null = null;
  try {
    fd = openSync(path, OPEN_FLAGS);
    const info = fstatSync(fd);
    if (!info.isFile()) return { kind: 'none' };
    if (needsShebang) {
      const head = Buffer.alloc(SHEBANG_BYTES);
      const read = readSync(fd, head, 0, SHEBANG_BYTES, 0);
      if (!SHELL_SHEBANG.test(head.toString('latin1', 0, read))) return { kind: 'none' };
    }
    if (info.size > MAX_SCRIPT_BYTES) return { kind: 'too-large' };
    const buffer = Buffer.alloc(info.size);
    let filled = 0;
    while (filled < info.size) {
      const read = readSync(fd, buffer, filled, info.size - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    return { kind: 'text', text: decodeScript(buffer.subarray(0, filled)) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== undefined && NO_SUCH_FILE.has(code) ? { kind: 'none' } : { kind: 'unreadable' };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
