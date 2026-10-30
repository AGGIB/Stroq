const patterns = {
  workspace: /^workspace-[a-f0-9]{24}$/,
  registration: /^item-[a-f0-9]{24}$/,
  binding: /^binding-[a-f0-9]{64}$/,
  tool: /^tool-[a-f0-9]{64}$/,
  version: /^[a-f0-9]{64}$/,
};
export interface McpToolContractSelection {
  requested: boolean;
  invalid: boolean;
  workspaceId: string | null;
  registrationId: string | null;
  bindingId: string | null;
  toolId: string | null;
  contractSha256: string | null;
}
export function mcpToolContractSelection(
  params: Pick<URLSearchParams, 'get' | 'getAll' | 'has'>,
): McpToolContractSelection {
  const keys = Object.keys(patterns) as (keyof typeof patterns)[];
  const requested = keys.some((key) => params.has(key));
  const workspaceId = params.get('workspace'),
    registrationId = params.get('registration'),
    bindingId = params.get('binding'),
    toolId = params.get('tool'),
    contractSha256 = params.get('version');
  const valid =
    !requested ||
    (keys.every(
      (key) =>
        params.getAll(key).length <= 1 &&
        (!params.has(key) || patterns[key].test(params.get(key)!)),
    ) &&
      workspaceId !== null &&
      registrationId !== null &&
      bindingId !== null &&
      ((toolId === null && contractSha256 === null) ||
        (toolId !== null && contractSha256 !== null)));
  return {
    requested,
    invalid: !valid,
    workspaceId: valid ? workspaceId : null,
    registrationId: valid ? registrationId : null,
    bindingId: valid ? bindingId : null,
    toolId: valid ? toolId : null,
    contractSha256: valid ? contractSha256 : null,
  };
}
export function mcpToolContractReadAllowed(
  selection: McpToolContractSelection,
  workspaceId: string | null,
) {
  return (
    workspaceId !== null &&
    patterns.workspace.test(workspaceId) &&
    !selection.invalid &&
    (!selection.requested || selection.workspaceId === workspaceId)
  );
}
export function mcpToolContractHref(
  input: Partial<Omit<McpToolContractSelection, 'requested' | 'invalid'>> = {},
) {
  const params = new URLSearchParams();
  const fields = {
    workspace: input.workspaceId,
    registration: input.registrationId,
    binding: input.bindingId,
    tool: input.toolId,
    version: input.contractSha256,
  };
  for (const [key, value] of Object.entries(fields)) if (value != null) params.set(key, value);
  return params.size && !mcpToolContractSelection(params).invalid
    ? `/skills/mcp/contracts/?${params}`
    : '/skills/mcp/contracts/';
}
