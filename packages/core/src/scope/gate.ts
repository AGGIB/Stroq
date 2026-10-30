import type { KeyObject } from 'node:crypto';
import type { Decision } from '../types.js';
import { verifyEscalation } from './escalation.js';
import { firstHardClass } from './hard-set.js';
import { keyIdOf, type PublicKeyRead } from './keys.js';
import { digestOf } from './canonical.js';
import { type PathOptions, defaultPathOptions } from './paths.js';
import { type PermitRejection, verifyPermit } from './permit.js';
import {
  type Refusal,
  checkScope,
  wholeCallFingerprint,
  describeEscalationFingerprint,
} from './scope-check.js';
import type { PermitStore, StoreVoidReason } from './store.js';
import {
  type ScopeEvidence,
  type ScopeGate,
  type ScopeGateInput,
  type ScopeKind,
  type ScopeVerdict,
  type TaskAccessBinding,
  isTaskId,
} from './types.js';

/**
 * The task lock's decision on one call. Four steps, in this order, and the order is the
 * design: a step can only make the answer stricter than the one before it, never looser.
 *
 *   1. The permit. No task id: not a task (null). A task id and no permit file is a deleted
 *      contract, and so is one that is present but not good for any reason: every tool is
 *      denied, Read and Grep included.
 *   2. The hard set: a class no scope can lift.
 *   3. The scope: tools, paths, network, MCP, shell.
 *   4. The policy's own decision: a deny stays a deny, an ask becomes a deny (there is nobody
 *      to ask), an allow stays an allow.
 *
 * A signed escalation lifts the refusals of step 3 and the asks of step 4 for the exact
 * operation it names, once. It never reaches steps 1 and 2, and never a policy deny.
 */

/** What the gate needs to know about THIS run. Read on every call, so that a changed file is seen. */
export interface TaskRunContext {
  /** From the environment the launcher gave the agent's process tree (`STROQ_TASK_NONCE`). */
  readonly nonce: string;
  readonly projectRoot: string;
  /** Digest of the `policy.yaml` in force now. */
  readonly policyDigest: string;
  /** Digests of the other state files the permit pinned (the sealed secrets, for one). */
  readonly stateDigests: Readonly<Record<string, string>>;
}

export interface ScopeGateDeps {
  /** The task this process runs under, or null (or undefined) when it runs under none. */
  readonly taskId: string | null | undefined;
  readonly store: PermitStore;
  readonly keys: { readPublicKey(): PublicKeyRead };
  readonly context: () => TaskRunContext;
  readonly now?: () => Date;
  readonly paths?: PathOptions;
}

export type TaskVoidReason =
  StoreVoidReason | PermitRejection | 'missing' | 'key-missing' | 'key-bad' | 'exception';

/** More operations in one call than this cannot all be escalated, and are not tried. */
const MAX_LIFTED_OPERATIONS = 16;
const INVALID_TASK = 'invalid';
const accessSessions = new WeakMap<object, string>();

/** Only the gate can create a verified binding; copying/deserializing metadata loses authority. */
export function isVerifiedTaskAccessBinding(
  value: unknown,
  sessionId: string,
): value is TaskAccessBinding {
  return typeof value === 'object' && value !== null && accessSessions.get(value) === sessionId;
}

const safeTaskId = (taskId: string): string => (isTaskId(taskId) ? taskId : INVALID_TASK);

function verdict(
  taskId: string,
  decision: Decision,
  kind: ScopeKind,
  fingerprint?: string,
): ScopeVerdict {
  const ruleId = decision.ruleId ?? (kind === 'in-scope' ? 'task-in-scope' : 'task-policy');
  return {
    decision,
    taskId,
    evidence: {
      ruleId,
      kind,
      ...(fingerprint === undefined ? {} : { fingerprint }),
    } satisfies ScopeEvidence,
  };
}

const deny = (ruleId: string, reason: string): Decision => ({ effect: 'deny', ruleId, reason });

function voidVerdict(taskId: string, reason: TaskVoidReason): ScopeVerdict {
  return verdict(
    taskId,
    deny(
      `task-void:${reason}`,
      `This task's permit is not valid (${reason}), so every tool call is refused until the task is started again with a fresh permit.`,
    ),
    'void',
  );
}

const extendHint = (taskId: string, fingerprint: string): string =>
  `to extend: stroq permit extend ${taskId} ${fingerprint}`;

class Gate implements ScopeGate {
  constructor(
    private readonly deps: ScopeGateDeps,
    private readonly taskId: string,
  ) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /**
   * The task id says a task is running: the launcher gave it to the process tree. Whether its
   * permit file is still there is not asked, because a file an agent can delete must not be able
   * to turn the task off.
   */
  activeTask(): string | null {
    return safeTaskId(this.taskId);
  }

  async evaluate(input: ScopeGateInput): Promise<ScopeVerdict | null> {
    try {
      return this.decide(input);
    } catch {
      return voidVerdict(safeTaskId(this.taskId), 'exception');
    }
  }

  private decide(input: ScopeGateInput): ScopeVerdict | null {
    const { taskId, deps } = this;
    const id = safeTaskId(taskId);

    // Step 1: the permit.
    const found = deps.store.readPermit(taskId);
    if (found.kind === 'absent') return voidVerdict(id, 'missing');
    if (found.kind === 'void') return voidVerdict(id, found.reason);
    const key = deps.keys.readPublicKey();
    if (key.kind !== 'ok')
      return voidVerdict(id, key.kind === 'absent' ? 'key-missing' : 'key-bad');
    const run = deps.context();
    const now = this.now();
    const checked = verifyPermit(found.text, key.key, {
      now,
      nonce: run.nonce,
      projectRoot: run.projectRoot,
      sessionId: input.event.sessionId,
      policyDigest: run.policyDigest,
      stateDigests: run.stateDigests,
      taskId,
    });
    if (!checked.ok) return voidVerdict(id, checked.reason);

    // Step 2: the hard set, whatever the scope says.
    const hard = firstHardClass(input.classes);
    if (hard !== null) {
      return verdict(
        id,
        deny(
          `task-hard:${hard}`,
          `${hard} cannot be allowed by any task scope, whatever it lists.`,
        ),
        'hard',
      );
    }

    // Steps 3 and 4: the scope, then the policy.
    const policy = input.decision;
    const refusals = checkScope(checked.body.scope, input, deps.paths ?? defaultPathOptions());
    if (policy.effect === 'allow' && refusals.length === 0) return verdict(id, policy, 'in-scope');
    const refusal = refusals[0];
    if (policy.effect !== 'allow' && policy.effect !== 'ask') {
      // A deny stays a deny, and nothing here can lift it: an escalation is not even tried.
      // An effect nobody defined is read as a deny too.
      if (refusal !== undefined) return verdict(id, deny(refusal.ruleId, refusal.reason), 'scope');
      return verdict(
        id,
        policy.effect === 'deny' ? policy : deny('task-policy', 'unknown policy effect'),
        'policy',
      );
    }

    // What a policy asks about may be in the content of the call (a line written to a shell
    // profile), which a fingerprint of the path does not name: lifting an ask takes the whole call.
    const asked = policy.effect === 'ask';
    const needed = [
      ...new Set([
        ...refusals.flatMap((r) => r.fingerprints),
        ...(asked ? [wholeCallFingerprint(input)] : []),
      ]),
    ];
    const lifted = this.lifted(id, needed, key.key, run, now);
    if (lifted === null) {
      return verdict(
        id,
        {
          effect: 'allow',
          ruleId: 'task-escalation',
          reason: `Allowed once by a signed extension for ${needed.length === 1 ? 'this operation' : `these ${needed.length} operations`}.`,
        },
        'escalated',
        needed[0],
      );
    }
    const refused = this.refused(id, refusal, policy, lifted);
    // Metadata must not turn an unliftable denial into an approval opportunity. A
    // recorded signed session is required even though legacy permits may omit it.
    if (
      lifted === undefined ||
      needed.length > MAX_LIFTED_OPERATIONS ||
      checked.body.sessionId === undefined ||
      checked.body.sessionId !== input.event.sessionId
    )
      return refused;
    const described = describeEscalationFingerprint(input, lifted);
    if (described === null) return refused;
    const access: TaskAccessBinding = Object.freeze({
      ...described,
      ...(described.fingerprintKind === 'read-target'
        ? { target: Object.freeze(described.target) }
        : {}),
      permitBodySha256: digestOf(checked.body),
      keyId: keyIdOf(key.key),
      permitExpiresAt: checked.body.expiresAt,
      requiredFingerprints: Object.freeze([...needed]),
    });
    accessSessions.set(access, checked.body.sessionId);
    return { ...refused, access };
  }

  private refused(
    id: string,
    refusal: Refusal | undefined,
    policy: Decision,
    fingerprint: string | undefined,
  ): ScopeVerdict {
    const hint = fingerprint === undefined ? '' : `; ${extendHint(id, fingerprint)}`;
    if (refusal !== undefined) {
      return verdict(id, deny(refusal.ruleId, `${refusal.reason}${hint}`), 'scope', fingerprint);
    }
    return verdict(
      id,
      deny(
        `task-ask:${policy.ruleId ?? 'default'}`,
        `${policy.reason} (a task has no one to ask, so the question is a refusal)${hint}`,
      ),
      'ask',
      fingerprint,
    );
  }

  /**
   * Null when every operation has a good, unused escalation, and then they are all used up now.
   * Otherwise the first operation that has none, which is the one to name in the hint: after the
   * person extends it, the next refusal names the next.
   */
  private lifted(
    id: string,
    fingerprints: readonly string[],
    key: KeyObject,
    run: TaskRunContext,
    now: Date,
  ): string | undefined | null {
    if (fingerprints.length === 0 || fingerprints.length > MAX_LIFTED_OPERATIONS)
      return fingerprints[0];
    const texts: string[] = [];
    for (const fingerprint of fingerprints) {
      const read = this.deps.store.readEscalation(id, fingerprint);
      if (read.kind !== 'present') return fingerprint;
      const checked = verifyEscalation(read.text, key, {
        now,
        nonce: run.nonce,
        taskId: id,
        fingerprint,
      });
      if (!checked.ok) return fingerprint;
      texts.push(read.text);
    }
    const used = fingerprints.findIndex(
      (fingerprint, i) => !this.deps.store.consumeEscalation(id, fingerprint, texts[i] as string),
    );
    return used === -1 ? null : fingerprints[used];
  }
}

/**
 * The gate for the task this process runs under. A process under no task gets one that
 * says "not a task" to everything, so the caller never has to branch. A task id that is
 * `undefined` (a variable of the environment that is not set) is no task either, as `null` is;
 * an empty one is a task with an id that cannot be right, and everything is refused.
 */
export function createScopeGate(deps: ScopeGateDeps): ScopeGate {
  if (deps.taskId === null || deps.taskId === undefined)
    return { evaluate: async () => null, activeTask: () => null };
  return new Gate(deps, deps.taskId);
}
