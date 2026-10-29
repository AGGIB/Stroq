import { randomUUID } from 'node:crypto';
import { withLock } from '@stroq/core';
import {
  createMcpCallControlsStore,
  type McpCallControlDecision,
} from '../../packages/cli/src/mcp/call-control.ts';
import * as schema from '../lib/mcp-call-controls.ts';
import { validateMcpCallControlOverview } from '../lib/mcp-call-control-overview.ts';
import { readMcpCallControlOverview } from './mcp-call-control-overview.ts';
import {
  prepareRetainedCallControlPlan,
  applyRetainedCallControlPlan,
  type RetainedCallControlPlan,
} from './mcp-call-control-retained.ts';
import {
  selectMcpCallControl,
  callControlCandidate,
  callControlContext,
  type CallControlOptions,
  type SelectedCallControl,
} from './mcp-call-control-registrations.ts';
import { assertWritable, sameCapture, replaceConfig } from './mcp-containment-config.ts';
import { prepareApplyLock, binding, hash } from './mcp-containment-files.mjs';
import {
  reserveSetup,
  markSetupAuthority,
  finishSetup,
  readSetup,
  verifySetupConfiguration,
  type StoredSetup,
} from './mcp-call-control-setup.ts';
type SourcePlan = {
  kind: 'source';
  preview: schema.McpCallControlPreview;
  input: schema.McpCallControlSourcePreviewRequest;
  selected: SelectedCallControl;
  candidate: Buffer | null;
  expires: number;
};
type Plan = SourcePlan | RetainedCallControlPlan;
const errors = new Set(Object.keys(schema.MCP_CALL_CONTROL_ERROR_MESSAGES));
const fail = (error: string) => ({
  status:
    error === 'mcp-call-control-invalid'
      ? 400
      : ['mcp-call-control-stale', 'mcp-call-control-busy'].includes(error)
        ? 409
        : error === 'mcp-call-control-write-unconfirmed'
          ? 422
          : 503,
  body: { error },
});
const errorResult = (e: unknown) =>
  fail(errors.has((e as Error)?.message) ? (e as Error).message : 'mcp-call-control-unavailable');
const check = (condition: unknown, code = 'mcp-call-control-stale') => {
  if (!condition) throw new Error(code);
};
const success = (name: keyof typeof schema, body: unknown) => {
  check(
    JSON.stringify(body).length <= 512 * 1024 && (schema[name] as (v: unknown) => boolean)(body),
    'mcp-call-control-unavailable',
  );
  return { status: 200, body };
};
const nativeAction = (action: schema.McpCallControlAction) =>
  action === 'setup' ? ('configure-paused' as const) : action;
function matchingEvent(
  event: {
    id: string;
    controlId: string;
    previousEventId: string | null;
    action: string;
    invocationSha256: string;
  },
  input: schema.McpCallControlRecheckRequest,
) {
  return (
    event.id === input.operationId &&
    event.controlId === input.controlId &&
    event.previousEventId === input.expectedEventId &&
    event.action === nativeAction(input.action) &&
    event.invocationSha256 === input.invocationSha256
  );
}
function sameSelected(a: SelectedCallControl, b: SelectedCallControl) {
  return (
    a.scan.contextId === b.scan.contextId &&
    a.row.source.file === b.row.source.file &&
    binding(a.row.source.root) === binding(b.row.source.root) &&
    binding(a.scan.ctx.user) === binding(b.scan.ctx.user) &&
    sameCapture(a.row.capture, b.row.capture) &&
    a.binding?.invocationSha256 === b.binding?.invocationSha256 &&
    a.runtime.fingerprint === b.runtime.fingerprint &&
    a.inspection.capability === b.inspection.capability
  );
}
function permitted(action: schema.McpCallControlAction, s: SelectedCallControl) {
  const i = s.inspection;
  if (!s.binding || !s.proxy || !s.scan.snapshot) return false;
  if (action === 'setup') return i.capability === 'setup-required' && i.current === null;
  if (action === 'resume') return i.capability === 'supported' && i.current?.mode === 'paused';
  if (action === 'pause')
    return ['supported', 'drifted'].includes(i.capability) && i.current?.mode === 'enabled';
  return i.capability === 'drifted' && i.current !== null;
}
/** Private TS backend is bundled into the existing MCP worker, never a new runtime script. */
export async function createMcpCallControlBackend(options: CallControlOptions) {
  let stopped = false,
    pending: Promise<unknown> | null = null;
  const plans = new Map<string, Plan>(),
    now = options.now ?? Date.now;
  const running = () => check(!stopped, 'mcp-call-control-unavailable');
  async function exclusive(work: () => Promise<unknown>) {
    if (stopped || pending) return fail('mcp-call-control-busy');
    const task = work().catch(errorResult);
    pending = task;
    try {
      return await task;
    } finally {
      pending = null;
    }
  }
  async function guard(plan: SourcePlan) {
    running();
    check(plan.expires > now());
    const fresh = await selectMcpCallControl(options, plan.input, plan.preview.controlId);
    check(sameSelected(plan.selected, fresh) && permitted(plan.input.action, fresh));
    await assertWritable(fresh.row.source, fresh.row.capture);
    running();
    check(plan.expires > now());
  }
  async function applyPlan(plan: SourcePlan): Promise<unknown> {
    const p = plan.preview,
      ctx = { ...plan.selected.scan.ctx, deadline: Date.now() + 10000 };
    let setup: StoredSetup | null = null,
      authority: 'confirmed' | 'unconfirmed' = 'unconfirmed',
      configuration: 'unchanged' | 'confirmed' | 'unconfirmed' =
        p.action === 'setup' ? 'unconfirmed' : 'unchanged',
      revision: string | null = null,
      eventId: string | null = null;
    await guard(plan);
    const lock = await prepareApplyLock(ctx.user.path);
    return withLock(
      lock.path,
      async () => {
        await guard(plan);
        if (plan.candidate) {
          const row = plan.selected.row;
          setup = await reserveSetup(ctx, {
            operationId: p.operationId,
            controlId: p.controlId,
            invocationSha256: p.invocationSha256,
            contextId: p.contextId,
            proxyWorkspaceId: p.proxyWorkspaceId,
            createdAt: p.createdAt,
            artifact: p.artifact,
            name: row.name,
            sourceType: row.source.source,
            relativePath: row.source.relativePath,
            sourceRootBinding: binding(row.source.root),
            userBinding: binding(ctx.user),
            configSha256: row.capture.sha256,
            mode: row.capture.mode,
            candidateSha256: hash(plan.candidate),
            before: row.capture.bytes,
            candidate: plan.candidate,
          });
        }
        const decision: McpCallControlDecision = {
          controlId: p.controlId,
          invocationSha256: p.invocationSha256,
          action: nativeAction(p.action),
          operationId: p.operationId,
          expectedRevision: p.expectedRevision,
          expectedEventId: p.expectedEventId,
        };
        try {
          const result = await createMcpCallControlsStore({
            home: plan.selected.scan.home,
            now: () => new Date(now()),
          }).decide(decision, { beforeCommit: () => guard(plan) });
          authority = 'confirmed';
          revision = result.state.revision;
          eventId = result.event.id;
          if (setup) {
            setup = await markSetupAuthority(ctx, setup, eventId, revision!);
            check(options.fault !== 'after-authority', 'mcp-call-control-write-unconfirmed');
            await guardConfiguration(plan);
            await replaceConfig(
              ctx,
              plan.selected.row.source,
              plan.selected.row.capture,
              { bytes: plan.candidate!, mode: plan.selected.row.capture.mode },
              options.fault ?? null,
            );
            configuration =
              (await verifySetupConfiguration(ctx, setup)) === 'confirmed'
                ? 'confirmed'
                : 'unconfirmed';
            setup = await finishSetup(ctx, setup, configuration);
          }
          running();
          check(
            plan.selected.runtime.fingerprint === (await options.runtimeDigest()),
            'mcp-call-control-write-unconfirmed',
          );
        } catch (e) {
          // Once publication may have occurred, only exact candidate recheck can resolve it.
          if (
            authority === 'unconfirmed' &&
            !(
              e instanceof Error &&
              ['mcp-call-control-write-unconfirmed', 'mcp-call-control-unavailable'].includes(
                e.message,
              )
            )
          )
            throw e;
          if (setup && authority === 'confirmed')
            try {
              await finishSetup(ctx, setup, 'unconfirmed');
            } catch {}
        }
        return success('validateMcpCallControlReceipt', {
          schema: 'stroq-mcp-call-control-receipt/1',
          previewId: p.id,
          operationId: p.operationId,
          workspaceId: p.workspaceId,
          proxyWorkspaceId: p.proxyWorkspaceId,
          contextId: p.contextId,
          action: p.action,
          artifact: p.artifact,
          controlId: p.controlId,
          invocationSha256: p.invocationSha256,
          expectedEventId: p.expectedEventId,
          completedAt: new Date(now()).toISOString(),
          authority,
          configuration,
          revision,
          eventId,
          requiresReconnect: p.requiresReconnect,
          hostEnforcement: false,
        });
      },
      { timeoutMs: 3000, fs: lock.fs },
    );
  }
  async function guardConfiguration(plan: SourcePlan) {
    // Native decision changed the ledger revision; compare the exact source/runtime instead.
    running();
    check(plan.expires > now());
    const fresh = await selectMcpCallControl(options, plan.input, plan.preview.controlId);
    check(
      fresh.scan.contextId === plan.preview.contextId &&
        fresh.row.source.file === plan.selected.row.source.file &&
        binding(fresh.row.source.root) === binding(plan.selected.row.source.root) &&
        sameCapture(fresh.row.capture, plan.selected.row.capture) &&
        fresh.binding?.invocationSha256 === plan.selected.binding.invocationSha256 &&
        fresh.runtime.fingerprint === plan.selected.runtime.fingerprint,
    );
    await assertWritable(fresh.row.source, fresh.row.capture);
  }
  return {
    state() {
      return exclusive(async () => {
        const body = await readMcpCallControlOverview(options);
        check(validateMcpCallControlOverview(body), 'mcp-call-control-unavailable');
        return { status: 200, body };
      });
    },
    inspect(input: unknown) {
      if (!schema.validateMcpCallControlSelection(input))
        return Promise.resolve(fail('mcp-call-control-invalid'));
      return exclusive(async () =>
        success(
          'validateMcpCallControlInspection',
          (await selectMcpCallControl(options, input)).inspection,
        ),
      );
    },
    preview(input: unknown) {
      if (!schema.validateMcpCallControlPreviewRequest(input))
        return Promise.resolve(fail('mcp-call-control-invalid'));
      return exclusive(async () => {
        if ('retainedSetupId' in input) {
          const plan = await prepareRetainedCallControlPlan(options, input, now());
          running();
          for (const [id, p] of plans) if (p.expires <= now()) plans.delete(id);
          check(plans.size < 8, 'mcp-call-control-limit');
          const result = success('validateMcpCallControlPreview', plan.preview);
          plans.set(plan.preview.id, plan);
          return result;
        }
        const context = await callControlContext(options);
        check(context.contextId === input.expectedContextId);
        const controlId = randomUUID(),
          s = await selectMcpCallControl(options, input, controlId);
        check(permitted(input.action, s), 'mcp-call-control-unsupported');
        check(
          s.scan.snapshot!.revision === input.expectedRevision &&
            (s.inspection.current?.eventId ?? null) === input.expectedEventId,
        );
        await assertWritable(s.row.source, s.row.capture);
        running();
        for (const [id, plan] of plans) if (plan.expires <= now()) plans.delete(id);
        check(plans.size < 8, 'mcp-call-control-limit');
        const at = now(),
          p: schema.McpCallControlPreview = {
            schema: 'stroq-mcp-call-control-preview/1',
            id: randomUUID(),
            operationId: randomUUID(),
            createdAt: new Date(at).toISOString(),
            expiresAt: new Date(at + 120000).toISOString(),
            workspaceId: s.scan.ctx.workspaceId,
            proxyWorkspaceId: s.inspection.proxyWorkspaceId!,
            contextId: s.scan.contextId,
            action: input.action,
            artifact: s.inspection.artifact,
            controlId: s.binding.controlId,
            invocationSha256:
              input.action === 'pause'
                ? s.inspection.current!.invocationSha256
                : s.binding.invocationSha256,
            expectedRevision: input.expectedRevision,
            expectedEventId: input.expectedEventId,
            changesConfiguration: input.action === 'setup',
            requiresReconnect: input.action === 'setup',
            sharedUserScope: s.row.source.scope === 'user',
            retention: {
              maxControls: 64,
              maxEvents: 512,
              maxBytes: 1048576,
              setupMaxRecords: 32,
              setupMaxBytes: 17825792,
            },
            hostEnforcement: false,
          };
        const result = success('validateMcpCallControlPreview', p);
        plans.set(p.id, {
          kind: 'source',
          preview: p,
          input: { ...input },
          selected: s,
          candidate: input.action === 'setup' ? callControlCandidate(s) : null,
          expires: at + 120000,
        });
        return result;
      });
    },
    apply(input: unknown) {
      const id =
          input !== null && typeof input === 'object' && !Array.isArray(input)
            ? (input as Record<string, unknown>).previewId
            : null,
        plan = typeof id === 'string' ? plans.get(id) : null;
      if (typeof id === 'string') plans.delete(id);
      if (!schema.validateMcpCallControlApplyRequest(input))
        return Promise.resolve(fail('mcp-call-control-invalid'));
      if (!plan) return Promise.resolve(fail('mcp-call-control-stale'));
      return exclusive(async () =>
        plan.kind === 'source'
          ? applyPlan(plan)
          : success(
              'validateMcpCallControlReceipt',
              await applyRetainedCallControlPlan(options, plan, now, running),
            ),
      );
    },
    recheck(input: unknown) {
      if (!schema.validateMcpCallControlRecheckRequest(input))
        return Promise.resolve(fail('mcp-call-control-invalid'));
      return exclusive(async () => {
        const { ctx, home, contextId } = await callControlContext(options);
        check(contextId === input.expectedContextId);
        let authority: 'recorded' | 'absent' | 'unavailable' = 'unavailable',
          configuration: 'unchanged' | 'confirmed' | 'unconfirmed' | 'unavailable' =
            input.action === 'setup' ? 'unavailable' : 'unchanged',
          currentEventId: string | null = null,
          currentMode: 'paused' | 'enabled' | null = null;
        if (input.action === 'setup') {
          try {
            const record = await readSetup(ctx, input.operationId);
            if (record) {
              const m = record.manifest;
              check(
                m.contextId === contextId &&
                  m.artifact.id === input.id &&
                  m.artifact.sha256 === input.expectedSha256 &&
                  m.controlId === input.controlId &&
                  m.invocationSha256 === input.invocationSha256 &&
                  input.expectedEventId === null,
              );
              configuration = await verifySetupConfiguration(ctx, record);
            } else configuration = 'unconfirmed';
          } catch (e) {
            if ((e as Error).message === 'mcp-call-control-stale') throw e;
          }
        }
        try {
          const state = await createMcpCallControlsStore({ home }).read(),
            event = state.events.find((e) => e.id === input.operationId);
          if (event) check(matchingEvent(event, input));
          authority = event ? 'recorded' : 'absent';
          const c = state.controls.find((c) => c.controlId === input.controlId);
          currentEventId = c?.eventId ?? null;
          currentMode = c?.mode ?? null;
        } catch (e) {
          if ((e as Error).message === 'mcp-call-control-stale') throw e;
        }
        running();
        return success('validateMcpCallControlRecheck', {
          schema: 'stroq-mcp-call-control-recheck/1',
          checkedAt: new Date(now()).toISOString(),
          workspaceId: ctx.workspaceId,
          contextId,
          operationId: input.operationId,
          action: input.action,
          controlId: input.controlId,
          invocationSha256: input.invocationSha256,
          authority,
          recordedEventId: authority === 'recorded' ? input.operationId : null,
          configuration,
          currentEventId,
          currentMode,
          hostEnforcement: false,
        });
      });
    },
    async close() {
      stopped = true;
      plans.clear();
      await pending;
    },
  };
}
