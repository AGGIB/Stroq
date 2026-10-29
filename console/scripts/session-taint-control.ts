import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { serialize } from 'node:v8';
import { createWorkspaceReviewContext } from './workspace-review-context.mjs';
import { executeTaskLock } from './task-lock-runner.mjs';
import { withAgentConfigurationLock } from './agent-configuration-lock.mjs';
import {
  SESSION_TAINT_ERRORS,
  validateSessionTaintInspection,
  validateSessionTaintPreview,
  validateSessionTaintReceipt,
  validateSessionTaintState,
  type SessionTaintInspection,
  type SessionTaintPreview,
} from '../lib/session-taint.ts';

const TTL = 120000,
  MAX_MEMORY = 8 * 1024 * 1024;
const exact = (v: unknown, keys: string[]): v is Record<string, any> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const selection = (v: unknown, revision = false): v is Record<string, any> =>
  exact(v, ['id', 'expectedEvidenceSha', ...(revision ? ['expectedRevisionSha256'] : [])]) &&
  sha(v.expectedEvidenceSha) &&
  v.id === `incident-${v.expectedEvidenceSha}` &&
  (!revision || sha(v.expectedRevisionSha256));
const fail = (error: string, status = 503) => ({ status, body: { error } });
function codeOf(error: unknown) {
  const message = (error as Error)?.message;
  const mapped: Record<string, string> = {
    'agent-configuration-busy': 'session-busy',
    'agent-configuration-unavailable': 'runtime-unavailable',
    'engine-unavailable': 'runtime-unavailable',
    'stale-capture': 'stale-state',
    'preview-stale': 'stale-state',
    'unsafe-source': 'unsafe-state',
  };
  const code = mapped[message] ?? message;
  return (SESSION_TAINT_ERRORS as readonly string[]).includes(code)
    ? code
    : 'session-taint-unavailable';
}
const statusOf = (code: string) =>
  [
    'stale-state',
    'preview-unavailable',
    'preview-expired',
    'session-busy',
    'stale-evidence',
  ].includes(code)
    ? 409
    : code === 'invalid-request'
      ? 400
      : code === 'deadline-exceeded'
        ? 504
        : [
              'write-unconfirmed',
              'unsafe-state',
              'recovery-required',
              'recovery-full',
              'not-tainted',
              'platform-unsupported',
            ].includes(code)
          ? 422
          : 503;
interface SavedPreview {
  report: SessionTaintPreview;
  plan: Record<string, any>;
  bound: any;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
}
const PRECOMMIT_FAILURES = new Set([
  'stale-state',
  'stale-evidence',
  'not-tainted',
  'preview-expired',
  'recovery-full',
  'recovery-required',
  'session-busy',
]);

/** Clear only one freshly selected session's stored taint; retain provenance and source evidence. */
export async function createSessionTaintControl(configuration: Record<string, any> = {}) {
  const ctx = configuration.context ?? (await createWorkspaceReviewContext(configuration));
  const execute = configuration.execute ?? executeTaskLock;
  const lock = configuration.withLock ?? withAgentConfigurationLock;
  const now = configuration.now ?? Date.now;
  const plans = new Map<string, SavedPreview>(),
    controllers = new Set<AbortController>(),
    pending = new Set<Promise<any>>();
  let stopped = false,
    busy = false;
  function assertLive() {
    if (stopped) throw new Error('server-stopped');
  }
  function track<T>(promise: Promise<T>) {
    pending.add(promise);
    promise.finally(() => pending.delete(promise)).catch(() => undefined);
    return promise;
  }
  function removePreview(id: string) {
    const saved = plans.get(id);
    if (!saved) return;
    plans.delete(id);
    clearTimeout(saved.timer);
  }
  function prune() {
    for (const [id, saved] of plans)
      if (now() >= Date.parse(saved.report.expiresAt)) removePreview(id);
  }
  async function worker(
    operation: string,
    input: unknown,
    bound: any,
    expiresAt: number | null = null,
    at = now(),
    onStart?: () => void,
  ) {
    assertLive();
    const controller = new AbortController();
    controllers.add(controller);
    try {
      return await execute(operation, input, {
        workerPath: configuration.sessionTaintWorkerPath ?? configuration.workerPath,
        timeoutMs: configuration.timeoutMs,
        signal: controller.signal,
        onStart,
        context: {
          project: ctx.project,
          userHome: ctx.roots.user.path,
          home: ctx.options.home,
          workspaceId: ctx.workspaceId,
          storeId: ctx.storeId,
          roots: ctx.roots,
          rootBindings: ctx.roots,
          paths: ctx.options.paths,
          platform: ctx.options.platform ?? process.platform,
          ...bound,
          now: new Date(at).toISOString(),
          configurationLockHeld: ['taint-apply', 'taint-recheck'].includes(operation),
          commitGuard: { runtimePaths: { ...ctx.options.paths }, expiresAt },
        },
      });
    } finally {
      controllers.delete(controller);
    }
  }
  async function locked(bound: any, action: () => Promise<any>) {
    return lock(
      { home: ctx.options.home, version: bound.engineVersion, runtime: bound.runtimeSha256 },
      async () => {
        assertLive();
        await ctx.assert(bound);
        return action();
      },
      { timeoutMs: 3000 },
    );
  }
  async function select(input: Record<string, any>) {
    if (typeof configuration.selectEvidence !== 'function') throw new Error('runtime-unavailable');
    const selected = await configuration.selectEvidence({
      id: input.id,
      expectedEvidenceSha: input.expectedEvidenceSha,
    });
    if (
      !selected ||
      !Number.isSafeInteger(selected.seq) ||
      selected.seq < 1 ||
      typeof selected.ts !== 'string' ||
      !Number.isFinite(Date.parse(selected.ts)) ||
      new Date(selected.ts).toISOString() !== selected.ts
    )
      throw new Error('stale-evidence');
    return {
      id: input.id,
      expectedEvidenceSha: input.expectedEvidenceSha,
      sequence: selected.seq,
      recordedAt: selected.ts,
    };
  }
  function matches(report: SessionTaintInspection, selected: Record<string, any>) {
    return (
      report.workspaceId === ctx.workspaceId &&
      report.incident.id === selected.id &&
      report.incident.evidenceSha256 === selected.expectedEvidenceSha &&
      report.incident.sequence === selected.sequence &&
      report.incident.recordedAt === selected.recordedAt
    );
  }
  async function getState() {
    try {
      assertLive();
      const bound = await ctx.current(),
        body = await worker('taint-state', {}, bound);
      await ctx.assert(bound);
      assertLive();
      if (!validateSessionTaintState(body) || body.workspaceId !== ctx.workspaceId)
        throw new Error('invalid-report');
      return { status: 200, body: structuredClone(body) };
    } catch (error) {
      const code = codeOf(error);
      return fail(code, statusOf(code));
    }
  }
  async function inspect(input: unknown) {
    if (!selection(input)) return fail('invalid-request', 400);
    if (stopped) return fail('server-stopped');
    if (busy) return fail('session-busy', 409);
    busy = true;
    try {
      const bound = await ctx.current(),
        selected = await select(input),
        body = await worker('taint-inspect', selected, bound);
      if (!validateSessionTaintInspection(body) || !matches(body, selected))
        throw new Error('invalid-report');
      if (!isDeepStrictEqual(await select(input), selected)) throw new Error('stale-evidence');
      await ctx.assert(bound);
      assertLive();
      return { status: 200, body: structuredClone(body) };
    } catch (error) {
      const code = codeOf(error);
      return fail(code, statusOf(code));
    } finally {
      busy = false;
    }
  }
  async function preview(input: unknown) {
    if (!selection(input, true)) return fail('invalid-request', 400);
    if (stopped) return fail('server-stopped');
    if (busy) return fail('session-busy', 409);
    busy = true;
    try {
      const bound = await ctx.current(),
        selected = await select(input),
        at = now(),
        expiresAt = at + TTL,
        previewId = randomUUID(),
        recordId = randomUUID();
      const output = await worker(
        'taint-preview',
        {
          ...selected,
          expectedRevisionSha256: input.expectedRevisionSha256,
          previewId,
          recordId,
          expiresAt,
        },
        bound,
        expiresAt,
        at,
      );
      if (
        !exact(output, ['report', 'plan']) ||
        !validateSessionTaintPreview(output.report) ||
        !exact(output.plan, ['schema', 'recordId', 'expiresAt', 'before', 'binding']) ||
        output.plan.schema !== 'stroq-session-taint-plan/1' ||
        output.plan.recordId !== recordId ||
        output.plan.expiresAt !== expiresAt ||
        !isDeepStrictEqual(output.plan.before, output.report.inspection) ||
        output.report.id !== previewId ||
        output.report.recordId !== recordId ||
        output.report.createdAt !== new Date(at).toISOString() ||
        output.report.expiresAt !== new Date(expiresAt).toISOString() ||
        output.report.inspection.revisionSha256 !== input.expectedRevisionSha256 ||
        !matches(output.report.inspection, selected)
      )
        throw new Error('invalid-report');
      if (!isDeepStrictEqual(await select(input), selected)) throw new Error('stale-evidence');
      await ctx.assert(bound);
      assertLive();
      if (now() >= expiresAt) throw new Error('preview-expired');
      const retained = {
        report: structuredClone(output.report),
        plan: structuredClone(output.plan),
        bound: structuredClone(bound),
      };
      const bytes = serialize(retained).byteLength;
      prune();
      if (
        plans.size >= 8 ||
        [...plans.values()].reduce((size, saved) => size + saved.bytes, bytes) > MAX_MEMORY
      )
        throw new Error('session-busy');
      const timer = setTimeout(() => removePreview(previewId), Math.max(1, expiresAt - now()));
      timer.unref();
      plans.set(previewId, { ...retained, bytes, timer });
      return { status: 200, body: structuredClone(output.report) };
    } catch (error) {
      const code = codeOf(error);
      return fail(code, statusOf(code));
    } finally {
      busy = false;
    }
  }
  async function clear(input: unknown) {
    // Even malformed consent or an overlapping attempt consumes a recognized preview.
    const previewId =
      input !== null && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>).previewId
        : null;
    const saved = uuid(previewId) ? plans.get(previewId) : undefined;
    if (uuid(previewId)) removePreview(previewId);
    if (
      !exact(input, [
        'previewId',
        'acknowledgeWeakenRestrictions',
        'acknowledgeRecoveryRetention',
      ]) ||
      !uuid(input.previewId) ||
      input.acknowledgeWeakenRestrictions !== true ||
      input.acknowledgeRecoveryRetention !== true
    )
      return fail('invalid-request', 400);
    if (stopped) return fail('server-stopped');
    if (busy) return fail('session-busy', 409);
    if (!saved) return fail('preview-unavailable', 409);
    busy = true;
    let launched = false;
    try {
      const expiresAt = Date.parse(saved.report.expiresAt);
      if (now() >= expiresAt) throw new Error('preview-expired');
      const body = await locked(saved.bound, async () => {
        if (now() >= expiresAt) throw new Error('preview-expired');
        // The person's two acknowledgements on this preview, handed to the clear, which records them.
        const confirmation = {
          weakensRestrictions: true,
          recoveryRetention: true,
          previewId: saved.report.id,
        };
        return worker(
          'taint-apply',
          { plan: saved.plan, confirmation },
          saved.bound,
          expiresAt,
          now(),
          () => {
            launched = true;
          },
        );
      });
      if (
        !validateSessionTaintReceipt(body) ||
        body.operation !== 'clear' ||
        body.record.id !== saved.report.recordId ||
        !isDeepStrictEqual(body.record.before, saved.report.inspection) ||
        body.record.before.workspaceId !== ctx.workspaceId
      )
        throw new Error('write-unconfirmed');
      try {
        await ctx.assert(saved.bound, true);
        assertLive();
      } catch {
        throw new Error('write-unconfirmed');
      }
      return { status: 200, body: structuredClone(body) };
    } catch (error) {
      const reported = codeOf(error);
      const code = launched && !PRECOMMIT_FAILURES.has(reported) ? 'write-unconfirmed' : reported;
      return fail(code, statusOf(code));
    } finally {
      busy = false;
    }
  }
  async function recheck(input: unknown) {
    if (!exact(input, ['recordId']) || !uuid(input.recordId)) return fail('invalid-request', 400);
    if (stopped) return fail('server-stopped');
    if (busy) return fail('session-busy', 409);
    busy = true;
    try {
      const bound = await ctx.current(),
        expiresAt = now() + TTL;
      const body = await locked(bound, () =>
        worker('taint-recheck', { recordId: input.recordId }, bound, expiresAt),
      );
      if (
        !validateSessionTaintReceipt(body) ||
        body.operation !== 'recheck' ||
        body.record.id !== input.recordId ||
        body.record.before.workspaceId !== ctx.workspaceId
      )
        throw new Error('invalid-report');
      try {
        await ctx.assert(bound, true);
        assertLive();
      } catch {
        throw new Error('write-unconfirmed');
      }
      return { status: 200, body: structuredClone(body) };
    } catch (error) {
      const code = codeOf(error);
      return fail(code, statusOf(code));
    } finally {
      busy = false;
    }
  }
  return {
    getState: () => track(getState()),
    inspect: (v: unknown) => track(inspect(v)),
    preview: (v: unknown) => track(preview(v)),
    clear: (v: unknown) => track(clear(v)),
    recheck: (v: unknown) => track(recheck(v)),
    async close() {
      stopped = true;
      for (const id of plans.keys()) removePreview(id);
      for (const controller of controllers) controller.abort();
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}
