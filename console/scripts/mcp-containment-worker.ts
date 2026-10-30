import { parentPort, workerData } from 'node:worker_threads';
import { resolve } from 'node:path';
import { MCP_CONTAINMENT_LIMITATIONS } from '../lib/mcp-containment.ts';
import { validRuntime } from './mcp-containment-proxy.ts';
import { hash } from './mcp-containment-files.mjs';
import {
  context,
  preparePlan,
  publicPreview,
  readState,
  applyPlan,
} from './mcp-containment-operations.ts';
export {
  readMcpToolContractState,
  prepareMcpToolContractDecision,
  applyMcpToolContractDecision,
} from './mcp-tool-contract-engine.ts';

export { createMcpCallControlBackend } from './mcp-call-control-backend.ts';

const known = new Set([
  'mcp-containment-conflict',
  'mcp-containment-unsupported',
  'mcp-containment-full',
  'mcp-containment-preview-stale',
  'mcp-containment-recovery-required',
  'mcp-containment-unavailable',
  'deadline-exceeded',
]);
async function run() {
  const { operation, project, userHome, platform, deadline } = workerData;
  let ctx;
  try {
    ctx = await context(
      project,
      userHome,
      platform,
      deadline,
      workerData.mcpEnvironment ?? {},
      validRuntime(workerData.runtime) ? workerData.runtime : null,
    );
  } catch (error) {
    if (operation !== 'state') throw error;
    return {
      kind: 'result',
      body: {
        schema: 'stroq-mcp-containment/2',
        source: 'local',
        generatedAt: new Date().toISOString(),
        workspaceId: `workspace-${hash(resolve(project)).slice(0, 24)}`,
        available: false,
        reason: 'context-unavailable',
        records: [],
        gaps: [],
        limitations: [...MCP_CONTAINMENT_LIMITATIONS],
      },
    };
  }
  if (operation === 'state')
    return { kind: 'result', body: await readState(ctx, workerData.runtimeAvailable === true) };
  if (operation === 'preview') {
    const { plan } = await preparePlan(
      ctx,
      workerData.input,
      workerData.recordId,
      workerData.createdAt,
    );
    return {
      kind: 'plan',
      plan,
      body: publicPreview(ctx, plan, workerData.previewId, workerData.expiresAt),
    };
  }
  if (operation === 'apply')
    return {
      kind: 'result',
      body: await applyPlan(ctx, workerData.plan, workerData.previewId, workerData.fault ?? null),
    };
  throw new Error('mcp-containment-unavailable');
}
if (parentPort)
  try {
    parentPort.postMessage(await run());
  } catch (error) {
    const message = (error as Error).message;
    parentPort?.postMessage({
      error: known.has(message)
        ? message
        : /^mcp-source-/.test(message) || message === 'record-invalid'
          ? 'mcp-containment-conflict'
          : 'mcp-containment-unavailable',
    });
  }
