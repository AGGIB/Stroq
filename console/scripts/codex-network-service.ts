import { serialize } from 'node:v8';
import { isDeepStrictEqual } from 'node:util';
import {
  validateCodexNetworkGuardSelection,
  validateCodexNetworkGuardRestoreSelection,
  validateCodexNetworkGuardRecheckSelection,
  validateCodexNetworkGuardPreview,
  type CodexNetworkGuardPreview,
} from '../lib/codex-network-guard';
import {
  validateCodexNetworkGuardPrivatePlan,
  codexNetworkGuardPrivatePlanBytes,
  type CodexNetworkGuardPrivatePlan,
} from '../lib/codex-network-guard-private';

export type NetworkReply = { status: number; body: any };
export interface NetworkInventory {
  codexNetworkRuntime(): Promise<string>;
  codexNetworkOperation(
    operation: string,
    data: unknown,
    options?: { writer?: boolean; deadline?: number; expectedRuntime?: string },
  ): Promise<NetworkReply>;
}
const exact = (v: any, keys: string[]) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Reflect.ownKeys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const failure = (error = 'codex-network-unavailable', status = 409): NetworkReply => ({
  status,
  body: { error },
});
const invalid = () => failure('invalid-request', 400);
const MAX_BYTES = 8 * 1024 * 1024;

/** Private one-use plans stay in memory; the existing inventory bridge owns every worker/lease. */
export function createCodexNetworkGuardService({
  inventory,
  now = Date.now,
}: {
  inventory: NetworkInventory;
  now?: () => number;
}) {
  const plans = new Map<
    string,
    {
      preview: CodexNetworkGuardPreview;
      privatePlan: CodexNetworkGuardPrivatePlan;
      runtime: string;
      expires: number;
      bytes: number;
    }
  >();
  let closed = false,
    busy = false;
  let admission: Promise<NetworkReply> | null = null;
  const prune = () => {
    for (const [id, p] of plans) if (p.expires <= now()) plans.delete(id);
  };
  const exclusive = (action: () => Promise<NetworkReply>): Promise<NetworkReply> => {
    if (closed) return Promise.resolve(failure('codex-network-unavailable', 503));
    if (busy) return Promise.resolve(failure('codex-network-busy'));
    busy = true;
    const pending = Promise.resolve()
      .then(() => (closed ? failure('codex-network-unavailable', 503) : action()))
      .catch(() => failure('codex-network-unavailable', 503))
      .finally(() => {
        busy = false;
        if (admission === pending) admission = null;
      });
    admission = pending;
    return pending;
  };
  return {
    read: () => exclusive(() => inventory.codexNetworkOperation('codex-network-state', {})),
    capture(input: unknown) {
      if (!exact(input, [])) return Promise.resolve(invalid());
      return exclusive(() => inventory.codexNetworkOperation('codex-network-capture', {}));
    },
    preview(input: unknown) {
      if (
        !validateCodexNetworkGuardSelection(input) &&
        !validateCodexNetworkGuardRestoreSelection(input)
      )
        return Promise.resolve(invalid());
      const request = structuredClone(input);
      return exclusive(async () => {
        prune();
        if (plans.size >= 8) return failure('codex-network-store-full');
        const runtime = await inventory.codexNetworkRuntime();
        const response = await inventory.codexNetworkOperation(
          'codex-network-preview',
          { request },
          { expectedRuntime: runtime },
        );
        if (response.status !== 200) return response;
        const { preview, privatePlan } = response.body ?? {};
        if (
          !validateCodexNetworkGuardPreview(preview) ||
          !validateCodexNetworkGuardPrivatePlan(privatePlan) ||
          !isDeepStrictEqual(preview, privatePlan.preview) ||
          !isDeepStrictEqual(request, privatePlan.request)
        )
          return failure('codex-network-unavailable', 503);
        const expires = Date.parse(preview.expiresAt),
          bytes = Math.max(
            serialize(privatePlan).byteLength,
            codexNetworkGuardPrivatePlanBytes(privatePlan),
          );
        if (
          closed ||
          expires <= now() ||
          Date.parse(preview.createdAt) > now() ||
          plans.has(preview.id)
        )
          return failure('codex-network-stale');
        if (runtime !== (await inventory.codexNetworkRuntime()))
          return failure('codex-network-runtime-changed');
        if (closed) return failure('codex-network-unavailable', 503);
        if (
          !Number.isSafeInteger(bytes) ||
          bytes > MAX_BYTES ||
          [...plans.values()].reduce((n, p) => n + p.bytes, bytes) > MAX_BYTES
        )
          return failure('codex-network-store-full');
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
      if (!plan || plan.expires <= now()) return Promise.resolve(failure('codex-network-stale'));
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
        if (plan.runtime !== (await inventory.codexNetworkRuntime()))
          return failure('codex-network-runtime-changed');
        if (closed) return failure('codex-network-unavailable', 503);
        return inventory.codexNetworkOperation(
          'codex-network-apply',
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
      if (!validateCodexNetworkGuardRecheckSelection(input)) return Promise.resolve(invalid());
      const request = structuredClone(input);
      return exclusive(() =>
        inventory.codexNetworkOperation('codex-network-recheck', { request }, { writer: true }),
      );
    },
    async close() {
      closed = true;
      plans.clear();
      await admission;
    },
  };
}
