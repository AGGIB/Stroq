import { canonicalizeToolsList, contractSha } from './tool-contract-canonical.js';
import type { ToolContractBinding, ToolContractCapture } from './tool-contract-types.js';

export function boundContractCapture(
  binding: ToolContractBinding,
  value: unknown,
): ToolContractCapture {
  const canonical = canonicalizeToolsList(value);
  const tools = canonical.tools.map((tool) => ({
    ...tool,
    id: 'tool-' + contractSha('stroq-mcp-tool-identity/1', [binding.id, binding.server, tool.name]),
  }));
  return {
    sha256: contractSha('stroq-mcp-bound-tools-list/1', [binding.id, canonical.sha256]),
    tools,
  };
}
