import { z } from 'zod';

/** Separate kind buckets share one versioned lock; writers preserve the other bucket. */
export const PassportLockSchema = z
  .object({
    v: z.literal(1),
    skills: z.record(z.string(), z.unknown()).default({}),
    mcp: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

/** A local confirmation, not a signature or evidence of who approved it. */
export const McpPinSchema = z.object({
  kind: z.literal('mcp'),
  status: z.literal('confirmed'),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  grant: z.object({ pin: z.string().regex(/^sha256:[0-9a-f]{64}$/) }),
});

/** Bound the lock before parsing; growing past this requires an explicit migration. */
export const MAX_PASSPORT_LOCK_BYTES = 4 * 1024 * 1024;
