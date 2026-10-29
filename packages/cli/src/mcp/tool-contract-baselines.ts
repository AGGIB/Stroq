import {
  canonicalizeToolsList,
  contractHash,
  contractRecord,
  exactContractKeys,
} from './tool-contract-canonical.js';
import { boundContractCapture } from './tool-contract-capture.js';
import {
  contractError,
  TOOL_CONTRACT_LIMITS as LIMIT,
  type ToolContractApprovedBaseline,
  type ToolContractBinding,
  type ToolContractEvent,
} from './tool-contract-types.js';

/** Revocation is a decision about permission, never a replacement of an approved body. */
function lastApprovals(history: readonly ToolContractEvent[]): Map<string, ToolContractEvent> {
  return new Map(
    history.filter((event) => event.action === 'approve').map((event) => [event.toolId, event]),
  );
}

export function decodeApprovedBaselines(
  value: unknown,
  binding: ToolContractBinding,
  history: readonly ToolContractEvent[],
): readonly ToolContractApprovedBaseline[] {
  const events = lastApprovals(history);
  if (!Array.isArray(value) || value.length > LIMIT.tools || value.length !== events.size)
    contractError('tool-contract-invalid');
  const seen = new Set<string>();
  const baselines: ToolContractApprovedBaseline[] = [];
  for (const row of value) {
    if (
      !contractRecord(row) ||
      Object.keys(row).length !== 4 ||
      !exactContractKeys(row, ['toolId', 'contractSha256', 'decidedAt', 'contract']) ||
      typeof row.toolId !== 'string' ||
      !contractHash(row.contractSha256) ||
      typeof row.decidedAt !== 'string' ||
      seen.has(row.toolId)
    )
      contractError('tool-contract-invalid');
    const event = events.get(row.toolId);
    if (!event || event.contractSha256 !== row.contractSha256 || event.at !== row.decidedAt)
      contractError('tool-contract-invalid');
    if (row.contract !== null) {
      const tool = boundContractCapture(binding, { tools: [row.contract] }).tools[0]!;
      if (tool.id !== row.toolId || tool.sha256 !== row.contractSha256)
        contractError('tool-contract-invalid');
    }
    seen.add(row.toolId);
    baselines.push(row as unknown as ToolContractApprovedBaseline);
  }
  // Reuse exact capture validation and its cumulative 1 MiB / 256-tool bounds. The
  // independent record/store caps continue to include both current and approved bodies.
  canonicalizeToolsList({
    tools: baselines.flatMap((baseline) => (baseline.contract === null ? [] : [baseline.contract])),
  });
  return baselines;
}
