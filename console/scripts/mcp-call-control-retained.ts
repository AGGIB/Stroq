import { createMcpCallControlsStore } from '../../packages/cli/src/mcp/call-control.ts';
import type { McpCallControlRetainedPreviewRequest } from '../lib/mcp-call-controls.ts';
import type { McpCallControlPreview, McpCallControlReceipt } from '../lib/mcp-call-controls.ts';
import { randomUUID } from 'node:crypto';
import { callControlContext, type CallControlOptions } from './mcp-call-control-registrations.ts';
import { readSetup } from './mcp-call-control-setup.ts';

/** A verified private setup record anchors only a stronger Pause for its durable native slot. */
export async function selectRetainedMcpCallControl(
  options: CallControlOptions,
  input: McpCallControlRetainedPreviewRequest,
) {
  const context = await callControlContext(options);
  const check = (v: unknown) => {
    if (!v) throw new Error('mcp-call-control-stale');
  };
  check(context.contextId === input.expectedContextId);
  const record = await readSetup(context.ctx, input.retainedSetupId);
  check(record !== null && record.manifest.contextId === context.contextId);
  const m = record!.manifest,
    state = await createMcpCallControlsStore({ home: context.home }).read(),
    event = state.events.find((e) => e.id === m.operationId),
    current = state.controls.find((c) => c.controlId === m.controlId);
  check(
    event?.controlId === m.controlId &&
      event.invocationSha256 === m.invocationSha256 &&
      event.action === 'configure-paused' &&
      event.previousEventId === null,
  );
  check(
    current?.mode === 'enabled' &&
      current.eventId === input.expectedEventId &&
      state.revision === input.expectedRevision,
  );
  return { ...context, record: record!, state, current: current! };
}
export type SelectedRetainedMcpCallControl = Awaited<
  ReturnType<typeof selectRetainedMcpCallControl>
>;
export type RetainedCallControlPlan = {
  kind: 'retained';
  input: McpCallControlRetainedPreviewRequest;
  preview: McpCallControlPreview;
  selected: SelectedRetainedMcpCallControl;
  expires: number;
};
export async function prepareRetainedCallControlPlan(
  options: CallControlOptions,
  input: McpCallControlRetainedPreviewRequest,
  now: number,
): Promise<RetainedCallControlPlan> {
  const selected = await selectRetainedMcpCallControl(options, input),
    m = selected.record.manifest;
  return {
    kind: 'retained',
    input: { ...input },
    selected,
    expires: now + 120000,
    preview: {
      schema: 'stroq-mcp-call-control-preview/1',
      id: randomUUID(),
      operationId: randomUUID(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 120000).toISOString(),
      workspaceId: selected.ctx.workspaceId,
      proxyWorkspaceId: m.proxyWorkspaceId,
      contextId: selected.contextId,
      action: 'pause',
      artifact: m.artifact,
      controlId: m.controlId,
      invocationSha256: selected.current.invocationSha256,
      expectedRevision: input.expectedRevision,
      expectedEventId: input.expectedEventId,
      changesConfiguration: false,
      requiresReconnect: false,
      sharedUserScope: m.artifact.scope === 'user',
      retention: {
        maxControls: 64,
        maxEvents: 512,
        maxBytes: 1048576,
        setupMaxRecords: 32,
        setupMaxBytes: 17825792,
      },
      hostEnforcement: false,
    },
  };
}
export async function applyRetainedCallControlPlan(
  options: CallControlOptions,
  plan: RetainedCallControlPlan,
  now: () => number,
  running: () => void,
): Promise<McpCallControlReceipt> {
  const p = plan.preview;
  const guard = async () => {
    running();
    if (plan.expires <= now()) throw new Error('mcp-call-control-stale');
    const fresh = await selectRetainedMcpCallControl(options, plan.input);
    if (
      fresh.record.manifestSha !== plan.selected.record.manifestSha ||
      fresh.current.invocationSha256 !== p.invocationSha256
    )
      throw new Error('mcp-call-control-stale');
  };
  await guard();
  let authority: 'confirmed' | 'unconfirmed' = 'unconfirmed',
    revision: string | null = null,
    eventId: string | null = null;
  try {
    const result = await createMcpCallControlsStore({
      home: plan.selected.home,
      now: () => new Date(now()),
    }).decide(
      {
        controlId: p.controlId,
        invocationSha256: p.invocationSha256,
        action: 'pause',
        operationId: p.operationId,
        expectedRevision: p.expectedRevision,
        expectedEventId: p.expectedEventId,
      },
      { beforeCommit: guard },
    );
    authority = 'confirmed';
    revision = result.state.revision;
    eventId = result.event.id;
  } catch (e) {
    if (
      !['mcp-call-control-write-unconfirmed', 'mcp-call-control-unavailable'].includes(
        (e as Error).message,
      )
    )
      throw e;
  }
  return {
    schema: 'stroq-mcp-call-control-receipt/1',
    previewId: p.id,
    operationId: p.operationId,
    workspaceId: p.workspaceId,
    proxyWorkspaceId: p.proxyWorkspaceId,
    contextId: p.contextId,
    action: 'pause',
    artifact: p.artifact,
    controlId: p.controlId,
    invocationSha256: p.invocationSha256,
    expectedEventId: p.expectedEventId,
    completedAt: new Date(now()).toISOString(),
    authority,
    configuration: 'unchanged',
    revision,
    eventId,
    requiresReconnect: false,
    hostEnforcement: false,
  };
}
