import { join } from 'node:path';
import { withLock } from '@stroq/core';
import { assertWriteAllowed, makePrivateDir, nodeFs } from './harden/atomic.js';
import type { Fs } from './harden/types.js';
import { hardenDirIn } from './paths.js';

/**
 * The lock the console's writers of agent settings share (hook setup and removal, workspace review
 * and watch, stored session taint), so that two of them never edit the same settings file at once.
 *
 * It is the lock `stroq harden` held while it edited the same files, at the same place and under
 * the same name: an older Stroq that is still installed keeps taking turns with this one.
 */
const LOCK_NAME = 'manifest.lock';
/** Long enough for several writers queued behind one slow disk, short enough to be an error. */
const LOCK_TIMEOUT_MS = 30_000;

export interface ConfigurationLockEnv {
  readonly home: string;
  readonly fs?: Fs;
}

export async function withConfigurationLock<T>(
  env: ConfigurationLockEnv,
  fn: () => Promise<T>,
  options: { readonly timeoutMs?: number } = {},
): Promise<T> {
  const fs = env.fs ?? nodeFs;
  const dir = hardenDirIn(env.home);
  const lock = join(dir, LOCK_NAME);
  // Asked first: the lock is made with `mkdir`, which would follow a link out of the home.
  assertWriteAllowed(lock, { root: env.home, initRule: false });
  await makePrivateDir(fs, dir);
  return withLock(lock, fn, { timeoutMs: options.timeoutMs ?? LOCK_TIMEOUT_MS });
}
