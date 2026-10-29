import { closed, hash } from '../lib/local-guards.ts';
import { validateCodexNetworkGuardCheckPreparation } from '../lib/codex-network-guard-check-private.ts';
import { captureNetworkGuard, assertNetworkCapture } from './codex-network-guard-capture.ts';
import { networkCheckRecipe } from './codex-network-guard-check-recipe.ts';
import { networkFail, type GuardOptions, type GuardHooks } from './codex-network-guard-binding.ts';

/** Passive policy-only preparation. This never invokes the native client. */
export async function prepareCodexNetworkCheck(
  options: GuardOptions,
  request: unknown,
  hooks: GuardHooks = {},
) {
  if (
    !closed(request, ['controlContextId', 'captureSha256']) ||
    Reflect.ownKeys(request).length !== 2 ||
    typeof request.controlContextId !== 'string' ||
    !/^codex-context-[a-f0-9]{64}$/.test(request.controlContextId) ||
    !hash(request.captureSha256)
  )
    networkFail('codex-network-stale');
  const capture = await captureNetworkGuard(options, hooks);
  if (
    capture.context.id !== request.controlContextId ||
    capture.binding.captureSha256 !== request.captureSha256
  )
    networkFail('codex-network-stale');
  if (!capture.public.canCheck) networkFail('codex-network-unsupported');
  const recipe = networkCheckRecipe(capture);
  const sourcePins = capture.sources.map((s) => ({
    id: s.id,
    scope: s.scope,
    path: s.path,
    root: s.root,
    sha256: s.snapshot.sha256,
    file: s.snapshot.file,
    directories: s.snapshot.directories,
  }));
  const result = {
    binding: capture.binding,
    ...recipe,
    native: capture.native,
    sourcePins,
    networkOff: true as const,
    managedUnverified: true,
  };
  if (!validateCodexNetworkGuardCheckPreparation(result)) networkFail('codex-network-unsupported');
  await assertNetworkCapture(options, capture, hooks);
  return result;
}
