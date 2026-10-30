import type { McpCallControlAudit, McpCallControlGuard } from './call-control-types.js';

/** Pause lease → optional approval lock → synchronous policy/control check and write. */
export async function dispatchControlledMcpCall<T>(options: {
  readonly guard?: McpCallControlGuard;
  readonly approval?: (write: () => void) => Promise<unknown>;
  readonly ended: () => boolean;
  readonly policy: () => 'changed' | 'unavailable' | null;
  readonly write: () => T;
}): Promise<{
  readonly delivery: T | undefined;
  readonly policyFailure: 'changed' | 'unavailable' | null;
  readonly refusal: McpCallControlAudit | null;
}> {
  let delivery: T | undefined;
  let policyFailure: 'changed' | 'unavailable' | null = null;
  const dispatch = async (check: () => McpCallControlAudit | null, markWritten: () => void) => {
    const write = (): void => {
      if (options.ended()) return;
      policyFailure = options.policy();
      if (policyFailure !== null || check() !== null) return;
      delivery = options.write();
      markWritten();
    };
    if (options.approval === undefined) write();
    else await options.approval(write);
    return delivery !== undefined;
  };
  const result =
    options.guard === undefined
      ? (await dispatch(
          () => null,
          () => {},
        ),
        { refusal: null })
      : await options.guard.run(dispatch);
  return { delivery, policyFailure, refusal: delivery === undefined ? result.refusal : null };
}
