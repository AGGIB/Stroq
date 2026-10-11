import type { KeyObject } from 'node:crypto';
import type { ToolClassification } from '../../src/actions/classify-tool.js';
import {
  type EscalationBody,
  newEscalationBody,
  signEscalation,
} from '../../src/scope/escalation.js';
import { createScopeGate, type TaskRunContext } from '../../src/scope/gate.js';
import { FileKeyStore, type KeyPair } from '../../src/scope/keys.js';
import type { PathOptions } from '../../src/scope/paths.js';
import { signPermit } from '../../src/scope/permit.js';
import { FilePermitStore } from '../../src/scope/store.js';
import type {
  PermitBody,
  ScopeGate,
  ScopeGateInput,
  ScopeVerdict,
  TaskScope,
} from '../../src/scope/types.js';
import type { ActionClass, Decision, ToolResources } from '../../src/types.js';
import {
  NOW,
  NONCE,
  POLICY_DIGEST,
  PROJECT,
  SESSION,
  STATE_DIGESTS,
  rawOf,
  sampleBody,
  sampleScope,
  tempDir,
} from './helpers.js';

/** Posix and case-exact on every machine, so these tests mean the same thing on Windows CI. */
export const POSIX_PATHS: PathOptions = { flavor: 'posix', foldCase: false };

export const ALLOW: Decision = { effect: 'allow', ruleId: null, reason: 'default' };
export const DENY: Decision = {
  effect: 'deny',
  ruleId: 'deny-network-when-tainted',
  reason: 'policy says no',
};
export const ASK: Decision = { effect: 'ask', ruleId: 'ask-destructive', reason: 'policy asks' };

export interface Fixture {
  readonly home: string;
  readonly taskId: string;
  readonly store: FilePermitStore;
  readonly keyStore: FileKeyStore;
  readonly pair: KeyPair;
  readonly clock: { now: Date };
  readonly run: TaskRunContext;
  readonly body: PermitBody;
  readonly gate: ScopeGate;
  /** Signs and stores an escalation for `fingerprint`, valid at `clock.now` unless `over` says not. */
  escalate(fingerprint: string, over?: Partial<EscalationBody>, key?: KeyObject): EscalationBody;
}

export interface FixtureOptions {
  readonly scope?: Partial<TaskScope>;
  readonly body?: Partial<PermitBody>;
  readonly run?: Partial<TaskRunContext>;
  /** `none` leaves the task without a permit file. */
  readonly permit?: 'write' | 'none';
  readonly requirePermit?: boolean;
}

/** A real key store, permit store and gate on a temp home: nothing here touches the real one. */
export function gateFixture(options: FixtureOptions = {}): Fixture {
  const home = tempDir('gate');
  const keyStore = new FileKeyStore({ home });
  const pair = keyStore.loadOrCreate();
  const store = new FilePermitStore({ home });
  const body = sampleBody({ scope: sampleScope(options.scope), ...options.body });
  const taskId = body.taskId;
  if (options.permit !== 'none')
    store.writePermit(taskId, rawOf(signPermit(body, pair.privateKey)));
  const clock = { now: NOW };
  const run: TaskRunContext = {
    nonce: NONCE,
    projectRoot: PROJECT,
    policyDigest: POLICY_DIGEST,
    stateDigests: { ...STATE_DIGESTS },
    ...options.run,
  };
  const gate = createScopeGate({
    taskId,
    store,
    keys: keyStore,
    context: () => run,
    now: () => clock.now,
    paths: POSIX_PATHS,
    ...(options.requirePermit === undefined ? {} : { requirePermit: options.requirePermit }),
  });
  return {
    home,
    taskId,
    store,
    keyStore,
    pair,
    clock,
    run,
    body,
    gate,
    escalate(fingerprint, over = {}, key = pair.privateKey) {
      const made = {
        ...newEscalationBody({ taskId, nonce: NONCE, fingerprint, now: clock.now }),
        ...over,
      };
      store.writeEscalation(taskId, fingerprint, rawOf(signEscalation(made, key)));
      return made;
    },
  };
}

export interface CallOptions {
  readonly classes?: readonly ActionClass[];
  readonly hosts?: readonly string[];
  readonly resources?: ToolResources;
  readonly mcp?: { server: string; tool: string };
  readonly decision?: Decision;
  readonly sessionId?: string;
}

export function callOf(
  toolName: string,
  toolInput: Record<string, unknown> = {},
  options: CallOptions = {},
): ScopeGateInput {
  const classes = options.classes ?? [];
  const classification: ToolClassification = {
    classes: [...classes],
    hosts: [...(options.hosts ?? [])],
    signals: [],
    ...(options.resources === undefined ? {} : { resources: options.resources }),
    ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
  };
  return {
    event: { sessionId: options.sessionId ?? SESSION, toolName, toolInput, cwd: PROJECT },
    classification,
    classes: [...classes],
    decision: options.decision ?? ALLOW,
  };
}

export type PathEntry =
  readonly ['read' | 'write', string] | readonly ['read' | 'write', string, string];

/** Resources for a call that touches `entries`, and whose paths are complete unless said otherwise. */
export function resourcesOf(
  entries: readonly PathEntry[],
  extra: Partial<ToolResources> = {},
): ToolResources {
  return {
    paths: entries.map(([op, path, real]) => ({
      op,
      path,
      ...(real === undefined ? {} : { real }),
    })),
    pathsComplete: true,
    urls: [],
    shell: false,
    ...extra,
  };
}

/** The verdict, which must not be null. */
export async function verdictOf(f: Fixture, input: ScopeGateInput): Promise<ScopeVerdict> {
  const verdict = await f.gate.evaluate(input);
  if (verdict === null) throw new Error('expected a verdict, got null');
  return verdict;
}
