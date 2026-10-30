import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULT_POLICY, parsePolicy, type Policy } from '@stroq/core';
import { policyFileIn } from '../paths.js';
import { MAX_POLICY_BYTES } from '../policy/load.js';
import { policySha256 } from '../policy/digest.js';

export type McpPolicyStatus = 'current' | 'changed' | 'unavailable';
export interface McpPolicyContinuity {
  /** A changed or unreadable policy requires a fresh proxy; recovery never silently resumes it. */
  check(): McpPolicyStatus;
}

const unavailable = () => new Error('MCP policy is unavailable');
const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const absent = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
const identity = (stat: BigIntStats) =>
  [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(':');

/** A dangling link or ENOTDIR is not an absent override. Do not create a missing home. */
function verifyAbsence(path: string): void {
  let parent = dirname(path);
  for (;;) {
    try {
      lstatSync(parent, { bigint: true });
      break;
    } catch (error) {
      if (!absent(error) || dirname(parent) === parent) throw unavailable();
      parent = dirname(parent);
    }
  }
  const before = statSync(parent, { bigint: true });
  if (!before.isDirectory()) throw unavailable();
  try {
    lstatSync(path, { bigint: true });
    throw unavailable();
  } catch (error) {
    if (!absent(error)) throw unavailable();
  }
  const after = statSync(parent, { bigint: true });
  if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino)
    throw unavailable();
}

/** One bounded descriptor read supplies both the engine's policy and its semantic identity. */
function readPolicy(path: string): Policy {
  let entry: BigIntStats;
  try {
    entry = lstatSync(path, { bigint: true });
  } catch (error) {
    if (!absent(error)) throw unavailable();
    verifyAbsence(path);
    return DEFAULT_POLICY;
  }
  // Resolve a stable source link, then refuse links substituted at the opened target.
  const target = realpathSync(path);
  const before = lstatSync(target, { bigint: true });
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size < 0n ||
    before.size > BigInt(MAX_POLICY_BYTES)
  )
    throw unavailable();
  const fd = openSync(target, flags);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || identity(opened) !== identity(before)) throw unavailable();
    const bytes = Buffer.alloc(Number(opened.size));
    let filled = 0;
    while (filled < bytes.length) {
      const count = readSync(fd, bytes, filled, bytes.length - filled, filled);
      if (count === 0) break;
      filled += count;
    }
    const extra = readSync(fd, Buffer.alloc(1), 0, 1, bytes.length);
    if (
      filled !== bytes.length ||
      extra !== 0 ||
      identity(opened) !== identity(fstatSync(fd, { bigint: true })) ||
      identity(opened) !== identity(lstatSync(target, { bigint: true })) ||
      realpathSync(path) !== target ||
      identity(entry) !== identity(lstatSync(path, { bigint: true }))
    )
      throw unavailable();
    return parsePolicy(decoder.decode(bytes));
  } finally {
    closeSync(fd);
  }
}

export function captureMcpPolicy(home: string): {
  policy: Policy;
  continuity: McpPolicyContinuity;
} {
  let path: string, policy: Policy, captured: string;
  try {
    // Resolve once: neither cwd nor STROQ_HOME changes can switch the observed source mid-session.
    path = resolve(policyFileIn(home));
    policy = structuredClone(readPolicy(path));
    captured = policySha256(policy);
  } catch {
    throw unavailable();
  }
  let status: McpPolicyStatus = 'current';
  return {
    policy,
    continuity: {
      check() {
        if (status !== 'current') return status;
        try {
          if (policySha256(readPolicy(path)) !== captured) status = 'changed';
        } catch {
          status = 'unavailable';
        }
        return status;
      },
    },
  };
}
