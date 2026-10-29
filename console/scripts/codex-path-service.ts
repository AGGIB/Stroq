import { serialize } from 'node:v8';
import { isDeepStrictEqual } from 'node:util';
import { closed } from '../lib/local-guards';
import {
  validateCodexPathGuardSelection,
  validateCodexPathGuardRestoreSelection,
  validateCodexPathGuardRecheckSelection,
  validateCodexPathGuardPreview,
  type CodexPathGuardPreview,
} from '../lib/codex-path-guard';
import {
  validateCodexPathGuardPrivatePlan,
  codexPathGuardPrivatePlanBytes,
  type CodexPathGuardPrivatePlan,
} from '../lib/codex-path-guard-private';

export type PathGuardReply = { status: number; body: any };
export interface PathGuardInventory {
  codexPathGuardRuntime(): Promise<string>;
  codexPathGuardOperation(
    operation: string,
    data: unknown,
    options?: { writer?: boolean; deadline?: number; expectedRuntime?: string },
  ): Promise<PathGuardReply>;
}
const exact = (v: any, keys: string[]) =>
  closed(v, keys) && Reflect.ownKeys(v).length === keys.length;
const failure = (error = 'codex-path-guard-unavailable', status = 409): PathGuardReply => ({
  status,
  body: { error },
});
const invalid = () => failure('invalid-request', 400);
const MAX_BYTES = 8 * 1024 * 1024;

/** Private one-use plans stay in memory; the existing inventory bridge owns every worker/lease. */
export function createCodexPathGuardService({
  inventory,
  now = Date.now,
}: {
  inventory: PathGuardInventory;
  now?: () => number;
}) {
  const plans = new Map<
    string,
    {
      preview: CodexPathGuardPreview;
      privatePlan: CodexPathGuardPrivatePlan;
      runtime: string;
      expires: number;
      bytes: number;
    }
  >();
  let closed = false,
    busy = false;
  let admission: Promise<PathGuardReply> | null = null;
  const prune = () => {
    for (const [id, p] of plans) if (p.expires <= now()) plans.delete(id);
  };
  const exclusive = (action: () => Promise<PathGuardReply>): Promise<PathGuardReply> => {
    if (closed) return Promise.resolve(failure('codex-path-guard-unavailable', 503));
    if (busy) return Promise.resolve(failure('codex-path-guard-busy'));
    busy = true;
    const pending = Promise.resolve()
      .then(() => (closed ? failure('codex-path-guard-unavailable', 503) : action()))
      .catch(() => failure('codex-path-guard-unavailable', 503))
      .finally(() => {
        busy = false;
        if (admission === pending) admission = null;
      });
    admission = pending;
    return pending;
  };
  return {
    read: () => exclusive(() => inventory.codexPathGuardOperation('codex-path-state', {})),
    capture(input: unknown) {
      if (!exact(input, [])) return Promise.resolve(invalid());
      return exclusive(() => inventory.codexPathGuardOperation('codex-path-capture', {}));
    },
    preview(input: unknown) {
      if (!validateCodexPathGuardSelection(input) && !validateCodexPathGuardRestoreSelection(input))
        return Promise.resolve(invalid());
      const request = structuredClone(input);
      return exclusive(async () => {
        prune();
        if (plans.size >= 8) return failure('codex-path-guard-store-full');
        const runtime = await inventory.codexPathGuardRuntime();
        const response = await inventory.codexPathGuardOperation(
          'codex-path-preview',
          { request },
          { expectedRuntime: runtime },
        );
        if (response.status !== 200) return response;
        const { preview, privatePlan } = response.body ?? {};
        if (
          !validateCodexPathGuardPreview(preview) ||
          !validateCodexPathGuardPrivatePlan(privatePlan) ||
          !isDeepStrictEqual(preview, privatePlan.preview) ||
          !isDeepStrictEqual(request, privatePlan.request)
        )
          return failure('codex-path-guard-unavailable', 503);
        const expires = Date.parse(preview.expiresAt),
          bytes = Math.max(
            serialize(privatePlan).byteLength,
            codexPathGuardPrivatePlanBytes(privatePlan),
          );
        if (
          closed ||
          expires <= now() ||
          Date.parse(preview.createdAt) > now() ||
          plans.has(preview.id)
        )
          return failure('codex-path-guard-stale');
        if (
          privatePlan.capture.binding.runtimeSha256 !== runtime ||
          runtime !== (await inventory.codexPathGuardRuntime())
        )
          return failure('codex-path-guard-runtime-changed');
        if (closed) return failure('codex-path-guard-unavailable', 503);
        if (
          !Number.isSafeInteger(bytes) ||
          bytes > MAX_BYTES ||
          [...plans.values()].reduce((n, p) => n + p.bytes, bytes) > MAX_BYTES
        )
          return failure('codex-path-guard-store-full');
        plans.set(preview.id, {
          preview: structuredClone(preview),
          privatePlan: structuredClone(privatePlan),
          runtime,
          expires,
          bytes,
        });
        return { status: 200, body: preview };
      });
    },
    apply(input: any) {
      // Recognition precedes shape, consent, context, busy and expiry checks. Never retry a write.
      const plan = input && typeof input === 'object' ? plans.get(input.previewId) : undefined;
      if (plan) plans.delete(input.previewId);
      prune();
      if (!plan || plan.expires <= now()) return Promise.resolve(failure('codex-path-guard-stale'));
      const restore = plan.preview.operation === 'restore';
      if (
        !exact(input, [
          'previewId',
          'controlContextId',
          'acknowledgeSharedUserConfig',
          'acknowledgeRetention',
          ...(restore ? ['acknowledgeWeakening'] : []),
        ]) ||
        input.controlContextId !== plan.preview.controlContextId ||
        input.acknowledgeSharedUserConfig !== true ||
        input.acknowledgeRetention !== true ||
        (restore && input.acknowledgeWeakening !== true)
      )
        return Promise.resolve(invalid());
      return exclusive(async () => {
        if (plan.runtime !== (await inventory.codexPathGuardRuntime()))
          return failure('codex-path-guard-runtime-changed');
        if (closed) return failure('codex-path-guard-unavailable', 503);
        return inventory.codexPathGuardOperation(
          'codex-path-apply',
          {
            privatePlan: plan.privatePlan,
            acknowledgeSharedUserConfig: true,
            acknowledgeRetention: true,
            ...(restore ? { acknowledgeWeakening: true } : {}),
          },
          { writer: true, deadline: plan.expires, expectedRuntime: plan.runtime },
        );
      });
    },
    recheck(input: unknown) {
      if (!validateCodexPathGuardRecheckSelection(input)) return Promise.resolve(invalid());
      const request = structuredClone(input);
      return exclusive(() =>
        inventory.codexPathGuardOperation('codex-path-recheck', { request }, { writer: true }),
      );
    },
    async close() {
      closed = true;
      plans.clear();
      await admission;
    },
  };
}
