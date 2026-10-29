export interface McpCallControlLocation {
  requested: boolean;
  invalid: boolean;
  controlId: string | null;
  contextId: string | null;
}
export function mcpCallControlLocation(
  params: Pick<URLSearchParams, 'get' | 'getAll' | 'has'>,
): McpCallControlLocation {
  const requested = params.has('control') || params.has('context'),
    controlId = params.get('control'),
    contextId = params.get('context');
  const invalid =
    ['control', 'context'].some((k) => params.getAll(k).length > 1) ||
    (requested &&
      (!controlId ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(controlId) ||
        !contextId ||
        !/^context-[a-f0-9]{64}$/.test(contextId)));
  return {
    requested,
    invalid,
    controlId: requested && !invalid ? controlId : null,
    contextId: requested && !invalid ? contextId : null,
  };
}
export function mcpCallControlSelected(
  location: McpCallControlLocation,
  state: { contextId: string; controls: readonly { controlId: string }[] } | null,
) {
  if (location.invalid) return 'invalid';
  if (!state) return 'loading';
  if (!location.requested) return 'overview';
  if (state.contextId !== location.contextId) return 'different-profile';
  return state.controls.some((c) => c.controlId === location.controlId) ? 'selected' : 'missing';
}
