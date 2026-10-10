import { z } from 'zod';
import type { ToolClassification } from '../actions/classify-tool.js';
import type { ActionClass, Decision, PreToolEvent } from '../types.js';

/**
 * The shapes of a task permit: a contract a person confirmed outside the agent, which
 * the engine holds every tool call against while the task runs.
 *
 * Every object is strict. A permit is read from a file the agent may be able to reach,
 * so a key this code does not know is not ignored, it is a reason to refuse the whole
 * permit: a field added by someone else could otherwise ride along inside bytes that
 * were signed, and a later version could start to read it.
 */

/** Task ids name a directory. Nothing outside this alphabet ever reaches a path. */
export const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const isTaskId = (value: unknown): value is string =>
  typeof value === 'string' && TASK_ID_PATTERN.test(value);

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[0-9a-f]{16}$/;
/** 64 bytes of ed25519 signature in unpadded base64url. */
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const STATE_LABEL = /^[A-Za-z0-9._-]{1,64}$/;
const ISO_FORM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const MAX_GLOBS = 256;
const MAX_GLOB_LENGTH = 1024;
const MAX_PATH_LENGTH = 4096;

/**
 * Exactly what `Date#toISOString` writes. `Date.parse` takes `"1"` for the year 2001 and moves
 * `02-31` to March, and a timestamp that two readers disagree about is a permit that two readers
 * disagree about.
 */
export function isCanonicalIso(value: string): boolean {
  if (!ISO_FORM.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/** A glob the scope can anchor: a POSIX root, a drive letter, or a UNC share. */
export function isAbsoluteGlob(glob: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(glob) && !glob.includes('\0');
}

/**
 * A host a scope may name: lower-case labels, or `*.` and at least two labels after it. A bare
 * `*` or `*.com` would be every host there is, which is the absence of a scope and not one.
 */
export function isHostPattern(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const wildcard = host.startsWith('*.');
  const labels = (wildcard ? host.slice(2) : host).split('.');
  if (wildcard && labels.length < 2) return false;
  return labels.every((label) => HOST_LABEL.test(label));
}

const Timestamp = z.string().refine(isCanonicalIso, 'not a canonical ISO timestamp');
const Hex64 = z.string().regex(HEX_64);
const Name = z.string().regex(NAME);
const Glob = z
  .string()
  .min(1)
  .max(MAX_GLOB_LENGTH)
  .refine(isAbsoluteGlob, 'a glob must be absolute');

export const PathRulesSchema = z.strictObject({
  allow: z.array(Glob).max(MAX_GLOBS),
  deny: z.array(Glob).max(MAX_GLOBS),
});

export const NetScopeSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('none') }),
  z.strictObject({
    mode: z.literal('hosts'),
    hosts: z.array(z.string().refine(isHostPattern, 'not a host pattern')).max(64),
  }),
]);

export const McpGrantSchema = z.strictObject({
  server: Name,
  tools: z.union([z.literal('*'), z.array(Name).max(256)]),
});

export const TaskScopeSchema = z.strictObject({
  tools: z.array(Name).max(64),
  read: PathRulesSchema,
  write: PathRulesSchema,
  net: NetScopeSchema,
  mcp: z.array(McpGrantSchema).max(32),
  shell: z.enum(['allowed', 'denied']),
});

export const PermitBodySchema = z.strictObject({
  v: z.literal(1),
  taskId: z.string().regex(TASK_ID_PATTERN),
  nonce: z.string().regex(NONCE),
  host: z.literal('claude-code'),
  profile: z.string().regex(SLUG),
  projectRoot: z
    .string()
    .min(1)
    .max(MAX_PATH_LENGTH)
    .refine((path) => !path.includes('\0'), 'a path has no NUL'),
  sessionId: z.string().regex(SESSION_ID).optional(),
  issuedAt: Timestamp,
  expiresAt: Timestamp,
  policyDigest: Hex64,
  stateDigests: z
    .record(z.string().regex(STATE_LABEL), Hex64)
    .refine((digests) => Object.keys(digests).length <= 32, 'too many state digests'),
  scope: TaskScopeSchema,
  screenDigest: Hex64,
});

export const SignedPermitSchema = z.strictObject({
  body: PermitBodySchema,
  keyId: z.string().regex(KEY_ID),
  sig: z.string().regex(SIGNATURE),
});

export type PathRules = z.infer<typeof PathRulesSchema>;
export type NetScope = z.infer<typeof NetScopeSchema>;
export type McpGrant = z.infer<typeof McpGrantSchema>;
export type TaskScope = z.infer<typeof TaskScopeSchema>;
export type PermitBody = z.infer<typeof PermitBodySchema>;
export type SignedPermit = z.infer<typeof SignedPermitSchema>;

/**
 * Why a verdict is what it is, in one word, for the audit entry. `void` is a permit that is
 * present and not good; `hard` a class no scope can lift; `scope` a refusal by the contract;
 * `ask` a policy question that a headless task cannot answer; `policy` a policy deny the task
 * leaves as it was; `escalated` a refusal a signed extension lifted once; `in-scope` an allow.
 */
export type ScopeKind = 'void' | 'hard' | 'scope' | 'ask' | 'policy' | 'escalated' | 'in-scope';

export interface ScopeEvidence {
  readonly ruleId: string;
  readonly kind: ScopeKind;
  /** The fingerprint `stroq permit extend` takes, on the refusals an extension could lift. */
  readonly fingerprint?: string;
}

/** What the gate says about one call. Its `decision` replaces the policy's. */
export interface ScopeVerdict {
  readonly decision: Decision;
  readonly taskId: string;
  readonly evidence: ScopeEvidence;
}

export interface ScopeGateInput {
  readonly event: PreToolEvent;
  readonly classification: ToolClassification;
  /** Every class of the call, the engine's additions (secrets, origin, decoys) included. */
  readonly classes: readonly ActionClass[];
  /** What the policy decided, after the way-out text was added. */
  readonly decision: Decision;
}

/**
 * The engine's seam for the task lock. `null` means the call is not part of a task and the
 * engine behaves as it always has; anything else replaces the policy's decision. `evaluate`
 * does not throw: a failure inside it is a deny, reported as a verdict.
 */
export interface ScopeGate {
  evaluate(input: ScopeGateInput): Promise<ScopeVerdict | null>;
  /**
   * The task this process runs under, or null. An adapter reads it to fail closed on every
   * tool and not only on the high-impact ones while a task is active.
   */
  activeTask(): string | null;
}
