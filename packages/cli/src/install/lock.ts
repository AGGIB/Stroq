import { mkdir } from 'node:fs/promises';
import { readRegularFile, withLock } from '@stroq/core';
import { z } from 'zod';
import { writeFileAtomic } from '../harden/atomic.js';
import { passportsFileIn, passportsLockDirIn } from '../paths.js';
import { rawMember } from './opaque-json.js';
import { PassportSchema } from './types.js';
import { PassportLockSchema, MAX_PASSPORT_LOCK_BYTES } from './passports-schema.js';

export { PassportLockSchema, McpPinSchema, MAX_PASSPORT_LOCK_BYTES } from './passports-schema.js';
export { readPassportLock } from './lock-reader.js';

export const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_LOCK_BYTES = MAX_PASSPORT_LOCK_BYTES;
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
const LockSchema = PassportLockSchema.extend({
  skills: z.record(z.string().regex(SKILL_NAME), SkillSchema).default({}),
  // MCP owns its record schema. Skill operations preserve it without granting a pin from it.
  // The parsed input is already JSON. Do not normalize fields owned by another kind.
  mcp: z.exactOptional(z.record(z.string(), z.unknown())),
});
const OPAQUE_MCP = Symbol('opaque MCP JSON');
export type Passports = z.infer<typeof LockSchema> & {
  readonly [OPAQUE_MCP]?: { json: string; parsed: string };
};

/** An invalid lock never becomes an empty lock: that would discard the owner's confirmations. */
export async function readPassports(home: string): Promise<Passports> {
  let read;
  try {
    read = readRegularFile(passportsFileIn(home), MAX_LOCK_BYTES, { noFollow: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, skills: {} };
    throw error;
  }
  if (read.kind !== 'text')
    throw new Error('cannot read the passports lock as a bounded regular file');
  try {
    const raw = JSON.parse(read.text) as { mcp?: Passports['mcp'] };
    const checked: Passports = LockSchema.parse(raw);
    const json = rawMember(read.text, 'mcp');
    if (raw.mcp !== undefined && json !== undefined) {
      // Preserve the original object too: z.record does not retain an own __proto__ key.
      return { ...checked, mcp: raw.mcp, [OPAQUE_MCP]: { json, parsed: JSON.stringify(raw.mcp) } };
    }
    return checked;
  } catch {
    throw new Error('the passports lock is invalid; refusing to replace it');
  }
}

export async function writePassports(home: string, lock: Passports): Promise<void> {
  const checked = LockSchema.parse(lock);
  const opaque = lock[OPAQUE_MCP];
  const mcp =
    opaque !== undefined && JSON.stringify(lock.mcp) === opaque.parsed
      ? opaque.json
      : JSON.stringify(lock.mcp ?? {});
  const text = `{\n  "v": 1,\n  "skills": ${JSON.stringify(checked.skills, null, 2)},\n  "mcp": ${mcp}\n}\n`;
  if (Buffer.byteLength(text) > MAX_LOCK_BYTES)
    throw new Error('the passports lock would exceed its read limit');
  await writeFileAtomic(passportsFileIn(home), text, {
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
  return withLock(passportsLockDirIn(home), async () => fn(await readPassports(home)));
}
