import { parseMcpArgv } from '../commands/mcp.js';
import { readMcpConfig, wrapperIndex } from '../commands/mcp-config.js';

export interface PinStatus {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Only wrapper flags count: a server's own --pin is data after the separator. */
export async function configPinStatus(file: string): Promise<readonly PinStatus[]> {
  let servers;
  try {
    servers = readMcpConfig(file).mcpServers;
  } catch {
    return [];
  }
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return [];
  const statuses: PinStatus[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      !('args' in entry) ||
      !Array.isArray(entry.args)
    )
      continue;
    const at = wrapperIndex(entry.args);
    if (at === null) continue;
    const args = entry.args.slice(at + 1).map(String);
    if (!args.slice(0, args.indexOf('--')).includes('--pin')) continue;
    const parsed = parseMcpArgv(args);
    const { quotePath } = await import('../install/safe-path.js');
    const result =
      parsed.ok && parsed.invocation.pin !== undefined
        ? await (
            await import('./pin.js')
          ).inspectPin({ ...parsed.invocation, pin: parsed.invocation.pin })
        : { ok: false, detail: 'invalid pinned wrapper; start refused' };
    statuses.push({ name: `mcp pin ${quotePath(name)}`, ...result });
  }
  return statuses;
}
