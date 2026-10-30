import { createHash, randomUUID } from 'node:crypto';
import { inspectInventoryEvidence } from './inventory-evidence.ts';
import { validateInventoryEvidence, type InventoryEvidence } from '../lib/inventory-evidence.ts';
import {
  INVENTORY_SIGNAL_LIMITATIONS,
  signalBindingKey,
  signalReasonMatches,
  validateInventorySignalBinding,
  type InventorySignalBinding,
  type InventorySignalProjection,
  type InventorySignalState,
  type SignalDecision,
  type SignalReason,
} from '../lib/inventory-signal-decision.ts';
import {
  inventorySignalBinding,
  inventorySignalContext,
  validSignalSha,
} from './inventory-signal-binding.ts';
import {
  appendSignalRecord,
  readSignalStore,
  storeRevision,
  type SignalStore,
} from './inventory-signal-store.ts';
import { runtimeDigest } from './agent-setup-cli.mjs';

export type SignalOptions = {
  project: string;
  userHome: string;
  home: string;
  deadline: number;
  runtimeSha256?: string;
  runtimePaths?: { cli: string; package: string; manifest?: string; manifestRoot?: string };
  previewExpiresAt?: number;
};
export type CompactSignalBinding = { binding: InventorySignalBinding; eligible: boolean };
const latest = (store: SignalStore, itemId: string) =>
  [...store.records].reverse().find((record) => record.binding.itemId === itemId) ?? null;
export function signalProjection(
  store: SignalStore,
  itemId: string,
  current?: CompactSignalBinding,
): InventorySignalProjection {
  if (store.status === 'unavailable') return { standing: 'unavailable', record: null };
  const record = latest(store, itemId);
  if (!record) return { standing: 'unresolved', record: null };
  if (record.decision === 'reopened') return { standing: 'reopened', record };
  return {
    standing:
      current?.eligible && signalBindingKey(current.binding) === signalBindingKey(record.binding)
        ? 'applies'
        : 'stale',
    record,
  };
}

/** Catalog uses bindings from its existing capture; it never reinspects every item. */
export async function inventorySignalCatalog(options: SignalOptions) {
  try {
    const contextSha256 = await inventorySignalContext(
      options.project,
      options.userHome,
      options.home,
    );
    const workspaceId = workspace(options.project);
    return await readSignalStore(options.home, workspaceId, contextSha256);
  } catch {
    return {
      status: 'unavailable',
      records: [],
      raw: { kind: 'unavailable', revision: null, location: null, file: null },
    } satisfies SignalStore;
  }
}
const workspace = (project: string) => {
  // Keep the existing inventory workspace identity byte-for-byte.
  return `workspace-${createWorkspaceHash(project)}`;
};
const createWorkspaceHash = (project: string) =>
  createHash('sha256').update(project).digest('hex').slice(0, 24);

function completeEvidence(evidence: InventoryEvidence) {
  return (
    evidence.scan.status !== 'incomplete' &&
    !evidence.scan.timedOut &&
    evidence.coverage.omittedFileDetails === 0 &&
    evidence.coverage.omittedMatchDetails === 0 &&
    !evidence.coverage.gaps.some((gap) =>
      ['capture-omissions', 'invalid-utf8', 'scan-timeout', 'scan-deadline'].includes(gap),
    )
  );
}

async function captureState(options: SignalOptions, id: string, expectedSha256: string) {
  if (Date.now() >= options.deadline) throw new Error('signal-conflict');
  if (!validSignalSha(options.runtimeSha256)) throw new Error('signal-store-unavailable');
  let sourceSha256: string | null = null;
  let evidence;
  try {
    evidence = await inspectInventoryEvidence({
      ...options,
      id,
      expectedSha256,
      onSkillCapture: (value) => {
        sourceSha256 = value;
      },
    });
  } catch {
    throw new Error('signal-conflict');
  }
  if (
    !validateInventoryEvidence(evidence) ||
    evidence.artifact.kind !== 'skill' ||
    !evidence.artifact.skillSource ||
    evidence.artifact.agent === 'claude-desktop' ||
    !sourceSha256
  )
    throw new Error('signal-conflict');
  const contextSha256 = await inventorySignalContext(
    options.project,
    options.userHome,
    options.home,
  );
  const store = await readSignalStore(options.home, evidence.workspaceId, contextSha256);
  const complete = completeEvidence(evidence);
  const binding = complete
    ? inventorySignalBinding(evidence, sourceSha256, options.runtimeSha256)
    : null;
  const eligible =
    complete &&
    evidence.scan.status === 'suspect' &&
    evidence.scan.findings > 0 &&
    store.status !== 'unavailable';
  const projection = signalProjection(store, id, binding ? { binding, eligible } : undefined);
  const records =
    store.status === 'unavailable'
      ? []
      : store.records.filter((record) => record.binding.itemId === id).reverse();
  const state: InventorySignalState = {
    schema: 'stroq-inventory-signal-state/1',
    source: 'local',
    generatedAt: new Date().toISOString(),
    workspaceId: evidence.workspaceId,
    artifact: {
      id,
      name: evidence.artifact.name,
      agent: evidence.artifact.agent,
      skillSource: evidence.artifact.skillSource,
      scope: evidence.artifact.scope,
      sha256: evidence.artifact.sha256,
    },
    binding,
    eligible,
    reason:
      store.status === 'unavailable'
        ? 'store-unavailable'
        : !complete
          ? 'incomplete'
          : eligible
            ? 'ready'
            : 'not-suspect',
    store: { status: store.status, revision: storeRevision(store) },
    standing: projection.standing,
    decision: projection.record,
    history: { records: records.slice(0, 32), omitted: Math.max(0, records.length - 32) },
    findings: evidence.scan.findings,
    limitations: [...INVENTORY_SIGNAL_LIMITATIONS],
  };
  return { state, store, contextSha256 };
}

function assertSelection(
  state: InventorySignalState,
  input: {
    expectedDecisionId: string | null;
    decision: SignalDecision;
    reason: SignalReason;
  },
) {
  if (state.store.status === 'unavailable') throw new Error('signal-store-unavailable');
  if (
    !signalReasonMatches(input.decision, input.reason) ||
    (state.decision?.id ?? null) !== input.expectedDecisionId
  )
    throw new Error('signal-conflict');
  if (
    !state.binding ||
    state.reason === 'incomplete' ||
    (input.decision !== 'reopened' && !state.eligible)
  )
    throw new Error('signal-incomplete');
  if (input.decision === 'reopened' && (!state.decision || state.decision.decision === 'reopened'))
    throw new Error('signal-conflict');
}

export async function runInventorySignalOperation(
  operation: string,
  options: SignalOptions,
  input: {
    id?: string;
    expectedSha256?: string;
    binding?: InventorySignalBinding;
    expectedDecisionId?: string | null;
    decision?: SignalDecision;
    reason?: SignalReason;
    signalLockHeld?: boolean;
  },
) {
  if (
    operation === 'signal-apply' &&
    (input.signalLockHeld !== true || !validateInventorySignalBinding(input.binding))
  )
    throw new Error('signal-conflict');
  if (
    operation === 'signal-apply' &&
    (!options.runtimePaths ||
      !Number.isFinite(options.previewExpiresAt) ||
      Date.now() >= options.previewExpiresAt!)
  )
    throw new Error('signal-conflict');
  const id = operation === 'signal-apply' ? input.binding!.itemId : input.id;
  const sha256 =
    operation === 'signal-apply' ? input.binding!.artifactSha256 : input.expectedSha256;
  if (!id || !/^item-[a-f0-9]{24}$/.test(id) || !validSignalSha(sha256))
    throw new Error('signal-conflict');
  const current = await captureState(options, id, sha256);
  if (operation === 'signal-state') return current.state;
  const selection = {
    expectedDecisionId: input.expectedDecisionId!,
    decision: input.decision!,
    reason: input.reason!,
  };
  assertSelection(current.state, selection);
  if (operation === 'signal-preview') return current.state;
  if (
    operation !== 'signal-apply' ||
    !current.state.binding ||
    signalBindingKey(current.state.binding) !== signalBindingKey(input.binding!)
  )
    throw new Error('signal-conflict');
  const record = {
    id: randomUUID(),
    binding: current.state.binding,
    decision: selection.decision,
    reason: selection.reason,
    recordedAt: new Date().toISOString(),
  };
  const written = await appendSignalRecord(
    options.home,
    current.state.workspaceId,
    current.contextSha256,
    current.store,
    record,
    async () => {
      const rechecked = await captureState(options, id, sha256);
      assertSelection(rechecked.state, selection);
      if (
        !rechecked.state.binding ||
        signalBindingKey(rechecked.state.binding) !== signalBindingKey(record.binding)
      )
        throw new Error('signal-conflict');
      try {
        if ((await runtimeDigest(options.runtimePaths)) !== options.runtimeSha256)
          throw new Error();
      } catch {
        throw new Error('signal-conflict');
      }
      if (Date.now() >= options.deadline || Date.now() >= options.previewExpiresAt!)
        throw new Error('signal-conflict');
    },
  );
  const records = written.records.filter((entry) => entry.binding.itemId === id).reverse();
  const projection = signalProjection(written, id, {
    binding: record.binding,
    eligible: current.state.eligible,
  });
  return {
    ...current.state,
    generatedAt: new Date().toISOString(),
    store: { status: written.status, revision: storeRevision(written) },
    standing: projection.standing,
    decision: projection.record,
    history: { records: records.slice(0, 32), omitted: Math.max(0, records.length - 32) },
  } satisfies InventorySignalState;
}
