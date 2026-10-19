import { existsSync } from 'node:fs';
import { isRecord } from '../adapters/tool-input.js';
import { parseMcpArgv } from '../commands/mcp.js';
import {
  entryRunsStrict,
  readMcpConfig,
  wrappedEntryPath,
  wrapperIndex,
} from '../commands/mcp-config.js';
import { reconfirmCommand } from './pin-argument.js';

export interface PinStatus {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const isWrapperWithPin = (
  entry: unknown,
): entry is { args: unknown[] } & Record<string, unknown> => {
  if (!isRecord(entry) || !Array.isArray(entry['args'])) return false;
  const at = wrapperIndex(entry['args']);
  if (at === null) return false;
  const args = entry['args'].slice(at + 1).map(String);
  return args
    .slice(0, args.indexOf('--'))
    .some((arg) => arg === '--pin' || arg.startsWith('--pin='));
};

/** The command line of an entry as a client starts it, or undefined when it is not a command and strings. */
function launchOf(entry: Record<string, unknown>) {
  const { command, args } = entry;
  return typeof command === 'string' &&
    Array.isArray(args) &&
    args.every((a) => typeof a === 'string')
    ? { command, argv: args as string[] }
    : undefined;
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
  const { quotePath } = await import('../install/safe-path.js');
  // Loaded here and not at the top: the hooks load this file, and must not load the lock reader with it.
  const { confirmedEntries } = await import('./confirmed-entries.js');
  const confirmed = confirmedEntries(file);
  for (const [name, entry] of Object.entries(servers)) {
    const label = `mcp pin ${quotePath(name)}`;
    if (!isWrapperWithPin(entry)) {
      // The lock says `add` confirmed a pinned wrapper under this name, and what stands there has no pin.
      if (confirmed.has(name))
        statuses.push({
          name: label,
          ok: false,
          detail: `the pin was taken out of this entry, or it is not the one confirmed; start is not guarded (to confirm it again run: ${reconfirmCommand(name)})`,
        });
      continue;
    }
    const args: string[] = entry.args.slice((wrapperIndex(entry.args) ?? 0) + 1).map(String);
    const parsed = parseMcpArgv(args);
    const launch = launchOf(entry);
    const result =
      parsed.ok && parsed.invocation.pin !== undefined
        ? await (
            await import('./pin.js')
          ).inspectPin({
            ...parsed.invocation,
            pin: parsed.invocation.pin,
            entry,
            ...(launch === undefined ? {} : { launch }),
          })
        : { ok: false, detail: 'invalid pinned wrapper; start refused' };
    const entryPath = wrappedEntryPath(entry.args);
    const finalResult =
      result.ok && entryPath !== null && !existsSync(entryPath)
        ? {
            ok: false,
            detail: `the recorded Stroq entry ${quotePath(entryPath)} no longer exists; start will fail (to confirm it again run: ${reconfirmCommand(name, { strict: entryRunsStrict(entry) })})`,
          }
        : result;
    statuses.push({ name: label, ...finalResult });
  }
  return statuses;
}
