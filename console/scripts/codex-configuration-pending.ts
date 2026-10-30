import { readControlVault } from './codex-skill-control-store.ts';
import { readNetworkGuardVault } from './codex-network-guard-store.ts';
import { readPathGuardVault } from './codex-path-guard-store.ts';
import type { ControlContext } from './codex-skill-control-binding.ts';
/** Before intent only. Metadata recheck stays available and never repairs another domain. */
export async function assertNoPendingCodexConfiguration(
  context: ControlContext,
  domain: 'skill' | 'network' | 'path',
) {
  const code =
    domain === 'skill'
      ? 'codex-control-recovery-required'
      : domain === 'network'
        ? 'codex-network-recovery-required'
        : 'codex-path-guard-recovery-required';
  try {
    const [skills, network, paths] = await Promise.all([
      readControlVault(context),
      readNetworkGuardVault(context),
      readPathGuardVault(context),
    ]);
    for (const vault of [skills, network, paths]) {
      if (
        vault.count > vault.records.length ||
        vault.pendingStaging ||
        vault.records.some((r) => ['prepared', 'restoring'].includes(r.manifest.phase))
      )
        throw Error(code);
    }
  } catch {
    throw Error(code);
  }
}
