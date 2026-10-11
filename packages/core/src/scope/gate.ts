import type { KeyObject } from 'node:crypto';
import type { Decision } from '../types.js';
import { verifyEscalation } from './escalation.js';
import { firstHardClass } from './hard-set.js';
import type { PublicKeyRead } from './keys.js';
import { type PathOptions, defaultPathOptions } from './paths.js';
import { type PermitRejection, verifyPermit } from './permit.js';
import { type Refusal, callFingerprints, checkScope } from './scope-check.js';
import type { PermitStore, StoreVoidReason } from './store.js';
import {
  type ScopeEvidence,
  type ScopeGate,
  type ScopeGateInput,
  type ScopeKind,
  type ScopeVerdict,
  isTaskId,
} from './types.js';

/**
 * The task lock's decision on one call. Four steps, in this order, and the order is the
 * design: a step can only make the answer stricter than the one before it, never looser.
 *
 *   1. The permit. None at all: not a task (null). One that is present but not good for any
 *      reason: every tool is denied, Read and Grep included.
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
  /** The task this process runs under, or null when it runs under none. */
  readonly taskId: string | null;
  readonly store: PermitStore;
  readonly keys: { readPublicKey(): PublicKeyRead };
  readonly context: () => TaskRunContext;
  readonly now?: () => Date;
  readonly paths?: PathOptions;
  /**
   * When the launcher knows a task is running, a missing permit file is not "no task": it is a
   * deleted contract, and everything is denied. Off by default, which is the plain reading of
   * "no permit, no task".
   */
  readonly requirePermit?: boolean;
}

export type TaskVoidReason =
  StoreVoidReason | PermitRejection | 'missing' | 'key-missing' | 'key-bad' | 'exception';

/** More operations in one call than this cannot all be escalated, and are not tried. */
const MAX_LIFTED_OPERATIONS = 16;
const INVALID_TASK = 'invalid';

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

  activeTask(): string | null {
    const id = safeTaskId(this.taskId);
    try {
      if (this.deps.requirePermit === true || !isTaskId(this.taskId)) return id;
      return this.deps.store.readPermit(this.taskId).kind === 'absent' ? null : id;
    } catch {
      // It cannot tell, and the answer that fails closed is "a task is running".
      return id;
    }
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
    if (found.kind === 'absent')
      return deps.requirePermit === true ? voidVerdict(id, 'missing') : null;
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

    const asked = policy.effect === 'ask';
    const needed = [
      ...new Set([
        ...refusals.flatMap((r) => r.fingerprints),
        ...(asked ? callFingerprints(input) : []),
      ]),
    ];
    if (this.lifted(id, needed, key.key, run, now)) {
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
    return this.refused(id, refusal, policy, needed[0]);
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

  /** Whether every operation has a good, unused escalation; if so, they are all used up now. */
  private lifted(
    id: string,
    fingerprints: readonly string[],
    key: KeyObject,
    run: TaskRunContext,
    now: Date,
  ): boolean {
    if (fingerprints.length === 0 || fingerprints.length > MAX_LIFTED_OPERATIONS) return false;
    const texts: string[] = [];
    for (const fingerprint of fingerprints) {
      const read = this.deps.store.readEscalation(id, fingerprint);
      if (read.kind !== 'present') return false;
      const checked = verifyEscalation(read.text, key, {
        now,
        nonce: run.nonce,
        taskId: id,
        fingerprint,
      });
      if (!checked.ok) return false;
      texts.push(read.text);
    }
    return fingerprints.every((fingerprint, i) =>
      this.deps.store.consumeEscalation(id, fingerprint, texts[i] as string),
    );
  }
}

/**
 * The gate for the task this process runs under. A process under no task gets one that
 * says "not a task" to everything, so the caller never has to branch.
 */
export function createScopeGate(deps: ScopeGateDeps): ScopeGate {
  if (deps.taskId === null) return { evaluate: async () => null, activeTask: () => null };
  return new Gate(deps, deps.taskId);
}
