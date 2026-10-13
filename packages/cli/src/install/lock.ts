import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readRegularFile, withLock } from '@stroq/core';
import { z } from 'zod';
import { writeFileAtomic } from '../harden/atomic.js';
import { PassportSchema } from './types.js';

export const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_LOCK_BYTES = 4 * 1024 * 1024;
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const ReceiptSchema = z.strictObject({
  v: z.literal(1),
  at: z.iso.datetime(),
  action: z.enum(['add', 'update', 'restore', 'remove']),
  name: z.string().regex(SKILL_NAME),
  from: digest.nullable(),
  to: digest.nullable(),
  material: z.boolean(),
  confirmed: z.boolean(),
  stroq: z.string().min(1),
});
export type Receipt = z.infer<typeof ReceiptSchema>;
const SkillSchema = z
  .strictObject({
    kind: z.literal('skill'),
    status: z.enum(['confirmed', 'drifted', 'revoked']),
    source: z.string().min(1),
    digest,
    passport: PassportSchema,
    installedTo: z.string().min(1),
    root: z.string().min(1),
    history: z.array(ReceiptSchema),
  })
  .refine(
    (entry) =>
      entry.passport.artifact.digest === entry.digest && entry.passport.artifact.kind === 'skill',
  );
export type SkillRecord = z.infer<typeof SkillSchema>;
const LockSchema = z.strictObject({
  v: z.literal(1),
  skills: z.record(z.string().regex(SKILL_NAME), SkillSchema),
  // MCP owns its record schema. Skill operations preserve it without granting a pin from it.
  mcp: z.exactOptional(z.record(z.string().min(1).max(128), z.json())),
});
export type Passports = z.infer<typeof LockSchema>;

/** An invalid lock never becomes an empty lock: that would discard the owner's confirmations. */
export async function readPassports(home: string): Promise<Passports> {
  let read;
  try {
    read = readRegularFile(join(home, 'passports.json'), MAX_LOCK_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, skills: {} };
    throw error;
  }
  if (read.kind !== 'text')
    throw new Error('cannot read the passports lock as a bounded regular file');
  try {
    return LockSchema.parse(JSON.parse(read.text));
  } catch {
    throw new Error('the passports lock is invalid; refusing to replace it');
  }
}

export async function writePassports(home: string, lock: Passports): Promise<void> {
  const checked = LockSchema.parse(lock);
  const text = `${JSON.stringify(checked, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_LOCK_BYTES)
    throw new Error('the passports lock would exceed its read limit');
  await writeFileAtomic(join(home, 'passports.json'), text, {
    root: home,
    initRule: false,
    mode: 0o600,
  });
}

export async function withPassports<T>(
  home: string,
  fn: (lock: Passports) => Promise<T>,
): Promise<T> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  return withLock(join(home, 'passports.lock'), async () => fn(await readPassports(home)));
}
