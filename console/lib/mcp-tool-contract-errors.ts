import { MCP_TOOL_CONTRACT_ERROR_MESSAGES } from './mcp-tool-contracts';
export function mcpToolContractError(value: unknown, fallback: string) {
  return value instanceof Error
    ? (Object.entries(MCP_TOOL_CONTRACT_ERROR_MESSAGES).find(
        ([code, message]) => value.message === code || value.message === message,
      )?.[1] ?? fallback)
    : fallback;
}
