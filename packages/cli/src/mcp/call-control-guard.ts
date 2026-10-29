import {
  readCallControlAuthoritySync,
  withCallControlLease,
  type CallControlLease,
} from './call-control-files.js';
import {
  callControlSha,
  callControlUuid,
  type McpCallControlAudit,
  type McpCallControlBinding,
  type McpCallControlGuard,
} from './call-control-types.js';

/** The selected-home lease covers approval waits, but never stream drain. */
export function createMcpCallControlGuard(
  binding: McpCallControlBinding,
  options: { readonly lockTimeoutMs?: number } = {},
): McpCallControlGuard {
  let lost = false;
  let homeBinding: string | null = null;
  /**
   * The longest history this connection has accepted: its event count and last event. The signed
   * history only grows (no event is ever removed), so its event count is its sequence. A shorter one,
   * or one that no longer starts with what was seen, is an older history this home signed, put back to
   * undo a later pause: refused, and latched like any other loss. A new connection has nothing to
   * compare with and accepts the first valid history it reads.
   */
  let seen: { readonly count: number; readonly lastEventId: string | null } = {
    count: 0,
    lastEventId: null,
  };
  const evidence = (reason: McpCallControlAudit['reason']): McpCallControlAudit => ({
    controlId: binding.controlId,
    invocationSha256: binding.invocationSha256,
    eventId: null,
    authoritySha256: null,
    reason,
  });
  const checkAuthority = (): McpCallControlAudit | null => {
    if (lost) return evidence('unavailable');
    try {
      const state = readCallControlAuthoritySync(binding.home);
      const current = state.controls.find((control) => control.controlId === binding.controlId);
      if (
        state.history !== 'ready' ||
        state.homeBinding === null ||
        (homeBinding !== null && state.homeBinding !== homeBinding) ||
        !current ||
        current.invocationSha256 !== binding.invocationSha256 ||
        state.events.length < seen.count ||
        (seen.count > 0 && state.events[seen.count - 1]?.id !== seen.lastEventId)
      ) {
        lost = true;
        return evidence('unavailable');
      }
      homeBinding = state.homeBinding;
      seen = { count: state.events.length, lastEventId: state.events.at(-1)?.id ?? null };
      return current.mode === 'paused'
        ? { ...evidence('paused'), eventId: current.eventId, authoritySha256: state.revision }
        : null;
    } catch {
      lost = true;
      return evidence('unavailable');
    }
  };
  if (!callControlUuid(binding.controlId) || !callControlSha(binding.invocationSha256)) lost = true;
  // The running connection is bound to the original verified home incarnation.
  checkAuthority();
  return {
    async run(callback) {
      if (lost) return { written: false, refusal: evidence('unavailable') };
      let written = false;
      let refusal: McpCallControlAudit | null = null;
      const underLease = async (lease: CallControlLease): Promise<void> => {
        const check = (): McpCallControlAudit | null => {
          if (lost) return (refusal = evidence('unavailable'));
          try {
            lease.assertCurrentSync();
          } catch {
            lost = true;
            return (refusal = evidence('unavailable'));
          }
          return (refusal = checkAuthority());
        };
        if (check() !== null) return;
        // markWritten survives an approval-lock release throwing after the callback wrote.
        const claimed = await callback(check, () => {
          written = true;
        });
        written ||= claimed;
      };
      try {
        await withCallControlLease(binding.home, false, underLease, options.lockTimeoutMs);
      } catch (error) {
        if (!written && error instanceof Error && error.message === 'mcp-call-control-busy')
          refusal = evidence('busy');
        else {
          lost = true;
          refusal = evidence('unavailable');
        }
      }
      return { written, refusal: written ? null : refusal };
    },
  };
}
