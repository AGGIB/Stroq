import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { stableStringify } from '@stroq/core';
import { parseMcpArgv } from '../../packages/cli/src/commands/mcp.ts';
import {
  createMcpToolContractBinding,
  createMcpToolContractsStore,
} from '../../packages/cli/src/mcp/tool-contracts.ts';
import { hashToolContractRuntime } from '../../packages/cli/src/mcp/tool-contract-runtime.ts';
import { compareMcpToolContract } from '../lib/mcp-tool-contract-comparison.ts';
import {
  MCP_TOOL_CONTRACT_LIMITATIONS,
  type McpToolContractRegistration,
  type McpToolContractState,
} from '../lib/mcp-tool-contracts.ts';
import {
  discoverMcpSources,
  readMcpSource,
  mcpArtifactId,
  mcpEntryMetadata,
} from './mcp-sources.ts';

type Options = {
  home: string;
  project: string;
  userHome: string;
  cli: string;
  platform: NodeJS.Platform;
  mcpEnvironment: Readonly<Record<string, string | undefined>>;
};
type Selection = {
  action: 'approve' | 'revoke';
  bindingId: string;
  expectedRevision: string;
  expectedCaptureSha256: string;
  toolId: string;
  expectedContractSha256: string;
};
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const fail = (): never => {
  throw new Error('tool-contract-stale');
};
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Inspect fixed supported registration sources; no upstream process or provider is invoked. */
async function registrations(options: Options) {
  const rows: {
    row: McpToolContractRegistration;
    binding: Awaited<ReturnType<typeof createMcpToolContractBinding>>;
  }[] = [];
  const gaps = new Set<'source-unavailable' | 'source-limit'>();
  const store = createMcpToolContractsStore({ home: options.home });
  let count = 0;
  let runtimeSha256: string | null = null;
  for (const source of await discoverMcpSources({ ...options, deadline: Date.now() + 10000 })) {
    if (source.applicability !== 'supported') continue;
    let captured;
    try {
      captured = await readMcpSource(source);
    } catch (error) {
      if ((error as Error).message !== 'mcp-source-missing') gaps.add('source-unavailable');
      continue;
    }
    const servers = captured.doc.mcpServers;
    if (!object(servers)) continue;
    for (const [name, entry] of Object.entries(servers)) {
      if (++count > 128) {
        gaps.add('source-limit');
        break;
      }
      if (
        !object(entry) ||
        entry.command !== process.execPath ||
        !Array.isArray(entry.args) ||
        !entry.args.every((v) => typeof v === 'string') ||
        entry.args[0] !== options.cli ||
        entry.args[1] !== 'mcp'
      )
        continue;
      const parsed = parseMcpArgv(entry.args.slice(2) as string[]);
      if (!parsed.ok || parsed.invocation.toolApproval !== true) continue;
      const invocation = parsed.invocation,
        environment = entry.env;
      if (
        Object.hasOwn(entry, 'url') ||
        Object.hasOwn(entry, 'serverUrl') ||
        (Object.hasOwn(entry, 'type') && entry.type !== 'stdio') ||
        (Object.hasOwn(entry, 'transport') && entry.transport !== 'stdio') ||
        invocation.strict !== true ||
        invocation.cloak ||
        invocation.pin ||
        invocation.passEnv === null ||
        invocation.server !== name ||
        invocation.client !== source.agent ||
        invocation.cwd !== options.project ||
        !object(environment) ||
        environment.STROQ_HOME !== options.home ||
        environment.HOME !== options.userHome ||
        environment.USERPROFILE !== options.userHome ||
        Object.values(environment).some((v) => typeof v !== 'string')
      ) {
        gaps.add('source-unavailable');
        continue;
      }
      const metadata = mcpEntryMetadata(entry);
      if (!metadata.sha256) {
        gaps.add('source-unavailable');
        continue;
      }
      runtimeSha256 ??= await hashToolContractRuntime(options.cli);
      const binding = await createMcpToolContractBinding({
        home: options.home,
        cwd: options.project,
        client: invocation.client,
        server: invocation.server,
        command: invocation.command,
        args: invocation.args,
        passEnv: invocation.passEnv,
        strictMaxWithheld: invocation.strictMaxWithheld,
        runtimeEntry: options.cli,
        runtimeSha256,
        environment: environment as Record<string, string>,
        launch: { command: process.execPath, argv: entry.args as string[] },
      });
      const snapshot = await store.read(binding);
      const tools =
        snapshot?.capture?.tools.map((tool) => {
          const approval = snapshot.approvals.find(
            (a) => a.toolId === tool.id && a.contractSha256 === tool.sha256,
          );
          const baseline = snapshot.approvedBaselines.find((row) => row.toolId === tool.id);
          const previousApprovedContract = baseline?.contract
            ? stableStringify(baseline.contract)
            : null;
          const contract = stableStringify(tool.contract);
          return {
            id: tool.id,
            name: tool.name,
            sha256: tool.sha256,
            contract,
            decision: approval
              ? approval.approved
                ? ('approved' as const)
                : ('revoked' as const)
              : ('pending' as const),
            previousApprovedContract,
            comparison: compareMcpToolContract(
              contract,
              previousApprovedContract,
              baseline ? { sha256: baseline.contractSha256, approvedAt: baseline.decidedAt } : null,
            ),
          };
        }) ?? [];
      rows.push({
        binding,
        row: {
          id: mcpArtifactId(source, name),
          name,
          agent: source.agent as McpToolContractRegistration['agent'],
          scope: source.scope,
          registrationSha256: metadata.sha256,
          bindingId: binding.id,
          revision: snapshot?.revision ?? null,
          status:
            snapshot === null
              ? 'none'
              : snapshot.observation === 'complete'
                ? 'complete'
                : 'incomplete',
          reason: snapshot?.observation === 'invalidated' ? 'listing-invalidated' : null,
          captureSha256: snapshot?.capture?.sha256 ?? null,
          observedAt: snapshot?.observedAt ?? null,
          tools,
          history: [...(snapshot?.history ?? [])],
        },
      });
    }
  }
  if (new Set(rows.map(({ row }) => row.bindingId)).size !== rows.length)
    gaps.add('source-unavailable');
  return { rows, gaps: [...gaps], store };
}
export async function readMcpToolContractState(options: Options): Promise<McpToolContractState> {
  const { rows, gaps } = await registrations(options);
  const state: McpToolContractState = {
    schema: 'stroq-mcp-tool-contracts/1',
    workspaceId: `workspace-${sha(resolve(options.project)).slice(0, 24)}`,
    generatedAt: new Date().toISOString(),
    available: gaps.length === 0,
    reason: gaps.length ? 'context-unavailable' : null,
    registrations: gaps.length ? [] : rows.map(({ row }) => row),
    gaps,
    limitations: [...MCP_TOOL_CONTRACT_LIMITATIONS],
  };
  if (Buffer.byteLength(JSON.stringify(state)) > 512 * 1024) throw new Error('tool-contract-limit');
  return state;
}
async function selected(options: Options, input: Selection) {
  const { rows, gaps, store } = await registrations(options);
  if (gaps.length) throw new Error('tool-contract-unavailable');
  const matches = rows.filter(({ row }) => row.bindingId === input.bindingId);
  if (matches.length !== 1) return fail();
  const { row, binding } = matches[0]!;
  const tool = row.tools.find(
    (tool) => tool.id === input.toolId && tool.sha256 === input.expectedContractSha256,
  );
  if (
    row.status !== 'complete' ||
    row.revision !== input.expectedRevision ||
    row.captureSha256 !== input.expectedCaptureSha256 ||
    !tool ||
    (input.action === 'approve' ? tool.decision === 'approved' : tool.decision !== 'approved')
  )
    return fail();
  return { row, binding, tool, store };
}
export async function prepareMcpToolContractDecision(options: Options, input: Selection) {
  const { row, tool } = await selected(options, input);
  return {
    registrationId: row.id,
    registrationSha256: row.registrationSha256,
    tool: {
      name: tool.name,
      contract: tool.contract,
      previousApprovedContract: tool.previousApprovedContract,
      comparison: tool.comparison,
    },
  };
}
export async function applyMcpToolContractDecision(
  options: Options,
  input: Selection,
  registrationId: string,
  registrationSha256: string,
  assertCurrent: () => Promise<void> = async () => {},
) {
  const { row, store } = await selected(options, input);
  if (row.id !== registrationId || row.registrationSha256 !== registrationSha256) return fail();
  return (
    await store.decide(input, {
      beforeCommit: async () => {
        await assertCurrent();
        const current = await selected(options, input);
        if (
          current.row.id !== registrationId ||
          current.row.registrationSha256 !== registrationSha256
        )
          return fail();
        await assertCurrent();
      },
    })
  ).revision;
}
