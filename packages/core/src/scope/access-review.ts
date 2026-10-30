import { z } from 'zod';
import { redact } from '../audit/audit-log.js';
import { MAX_TASK_ACCESS_REVIEW_BYTES } from './access-request.js';
import { parseStrictJson } from './strict-json.js';

const text = z.string().max(MAX_TASK_ACCESS_REVIEW_BYTES);
const target = z.strictObject({ path: text, real: text.optional(), op: z.enum(['read', 'write']) });
export const TaskAccessReviewSchema = z
  .strictObject({
    v: z.literal(1),
    tool: z.string().min(1).max(256),
    kind: z.enum(['read-target', 'whole-call']),
    input: z.record(z.string(), z.json()),
    cwd: text,
    resources: z
      .strictObject({
        paths: z.array(target),
        pathsComplete: z.boolean(),
        shell: z.boolean(),
        urls: z.array(z.strictObject({ url: text, host: text, method: text.optional() })),
      })
      .nullable(),
    target: target.optional(),
  })
  .superRefine((review, ctx) => {
    if (
      (review.kind === 'read-target') !== (review.target !== undefined) ||
      (review.kind === 'read-target' && review.tool !== 'Read')
    )
      ctx.addIssue({ code: 'custom', message: 'invalid target review' });
  });
export type TaskAccessReview = z.infer<typeof TaskAccessReviewSchema>;
const CREDENTIAL_KEY =
  /^(?:password|passwd|pwd|token|secret|api[_-]?key|x[_-]api[_-]key|authorization)$/i;

function credentialFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(credentialFields);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        CREDENTIAL_KEY.test(key) ? '[REDACTED]' : credentialFields(item),
      ]),
    );
  return value;
}

/** Complete, bounded strict JSON; this never recreates the original fingerprint from redacted input. */
export function parseTaskAccessReview(text: string): TaskAccessReview | null {
  try {
    if (Buffer.byteLength(text) > MAX_TASK_ACCESS_REVIEW_BYTES) return null;
    const parsed = parseStrictJson(text);
    if (!parsed.ok) return null;
    const shaped = TaskAccessReviewSchema.safeParse(parsed.value);
    return shaped.success ? shaped.data : null;
  } catch {
    return null;
  }
}

/** Redact strings before JSON encoding, so escaped credentials are not missed. Keys cannot be silently renamed. */
export async function makeTaskAccessReview(
  input: unknown,
  redactStrings: (values: readonly string[]) => Promise<readonly string[] | null>,
): Promise<string | null> {
  try {
    const raw = JSON.stringify(input);
    if (raw === undefined || Buffer.byteLength(raw) > MAX_TASK_ACCESS_REVIEW_BYTES) return null;
    const source = parseTaskAccessReview(raw);
    if (source === null || !TaskAccessReviewSchema.safeParse(input).success) return null;
    const labelled = credentialFields(source);
    const strings = new Set<string>();
    const visit = (value: unknown): void => {
      if (typeof value === 'string') strings.add(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value !== null && typeof value === 'object')
        for (const [key, item] of Object.entries(value)) {
          strings.add(key);
          visit(item);
        }
    };
    visit(labelled);
    const values = [...strings];
    const safe = await redactStrings(values);
    if (safe === null || safe.length !== values.length) return null;
    const replacements = new Map(values.map((value, index) => [value, safe[index]!]));
    let changedKey = false;
    const replace = (value: unknown): unknown => {
      if (typeof value === 'string') return replacements.get(value);
      if (Array.isArray(value)) return value.map(replace);
      if (value !== null && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => {
            if (replacements.get(key) !== key) changedKey = true;
            return [key, replace(item)];
          }),
        );
      return value;
    };
    const result = JSON.stringify(replace(labelled));
    if (changedKey || parseTaskAccessReview(result) === null || redact(result) !== result)
      return null;
    return result;
  } catch {
    return null;
  }
}
