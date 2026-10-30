import { isAbsolute, resolve } from 'node:path';
import { createMcpToolContractBinding } from '../../packages/cli/src/mcp/tool-contracts.ts';
import { hashToolContractRuntime } from '../../packages/cli/src/mcp/tool-contract-runtime.ts';
import { parseMcpArgv } from '../../packages/cli/src/commands/mcp.ts';
import { discoverMcpSources, readMcpSource } from './mcp-sources.ts';

export interface UniqueToolReviewOptions {
  project: string;
  userHome: string;
  home: string;
  cli: string;
  platform: NodeJS.Platform;
  mcpEnvironment: Readonly<Record<string, string | undefined>>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function unavailable(): never {
  throw new Error('mcp-containment-unavailable');
}
function unsupported(): never {
  throw new Error('mcp-containment-unsupported');
}

/** Read-only prevention; use the same native identity factory as physical proxy dispatch. */
export async function assertUniqueToolReviewBinding(
  options: UniqueToolReviewOptions,
  candidateEntry: unknown,
  targetConfigFile: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  const checkDeadline = () => {
    if (Date.now() >= deadline) unavailable();
  };
  try {
    const sources = await discoverMcpSources({
      project: options.project,
      userHome: options.userHome,
      platform: options.platform,
      environment: options.mcpEnvironment,
      deadline,
    });
    if (
      !isAbsolute(targetConfigFile) ||
      !sources.some(
        (source) =>
          source.applicability === 'supported' && source.file === resolve(targetConfigFile),
      )
    )
      unavailable();
    let runtimeSha256: string | null = null;
    async function binding(entry: unknown) {
      if (
        !object(entry) ||
        entry.command !== process.execPath ||
        !Array.isArray(entry.args) ||
        !entry.args.every((value) => typeof value === 'string') ||
        entry.args[0] !== options.cli ||
        entry.args[1] !== 'mcp'
      )
        return null;
      const parsed = parseMcpArgv(entry.args.slice(2) as string[]);
      if (!parsed.ok || !parsed.invocation.toolApproval) return null;
      const invocation = parsed.invocation,
        environment = entry.env;
      if (
        !invocation.strict ||
        invocation.cloak ||
        invocation.passEnv === null ||
        !invocation.cwd ||
        !isAbsolute(invocation.cwd) ||
        !object(environment) ||
        Object.values(environment).some((value) => typeof value !== 'string') ||
        typeof environment.STROQ_HOME !== 'string' ||
        !isAbsolute(environment.STROQ_HOME)
      )
        unavailable();
      if (invocation.passEnv.some((name) => !Object.hasOwn(environment, name))) unavailable();
      runtimeSha256 ??= await hashToolContractRuntime(options.cli);
      checkDeadline();
      const result = await createMcpToolContractBinding({
        home: environment.STROQ_HOME,
        cwd: invocation.cwd,
        client: invocation.client,
        server: invocation.server,
        command: invocation.command,
        args: invocation.args,
        passEnv: invocation.passEnv,
        strictMaxWithheld: invocation.strictMaxWithheld,
        ...(invocation.pin === undefined ? {} : { pin: invocation.pin }),
        runtimeEntry: options.cli,
        runtimeSha256,
        environment: environment as Record<string, string>,
        launch: { command: process.execPath, argv: entry.args as string[] },
      });
      checkDeadline();
      return result;
    }
    const candidate = await binding(candidateEntry);
    if (!candidate) unavailable();
    let entries = 0;
    for (const source of sources) {
      checkDeadline();
      if (source.applicability !== 'supported' || source.file === resolve(targetConfigFile))
        continue;
      let captured;
      try {
        captured = await readMcpSource(source);
      } catch (error) {
        if (error instanceof Error && error.message === 'mcp-source-missing') continue;
        unavailable();
      }
      checkDeadline();
      if (!object(captured.doc.mcpServers)) continue;
      for (const entry of Object.values(captured.doc.mcpServers)) {
        if (++entries > 128) unavailable();
        checkDeadline();
        const other = await binding(entry);
        if (other?.id === candidate.id) unsupported();
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'mcp-containment-unsupported') throw error;
    unavailable();
  }
}
