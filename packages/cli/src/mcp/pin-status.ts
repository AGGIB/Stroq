import { resolve } from 'node:path';
import { parseMcpArgv } from '../commands/mcp.js';
import { readMcpConfig, wrapperIndex } from '../commands/mcp-config.js';

export interface PinStatus {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What `add` wrote for each server it confirmed in this config file, by name, from the lock and not from the config. */
async function confirmedEntries(
  file: string,
): Promise<ReadonlyMap<string, Record<string, unknown>>> {
  const confirmed = new Map<string, Record<string, unknown>>();
  try {
    const { readPassportLock } = await import('../install/lock-reader.js');
    const { passportsFileIn, stroqHome } = await import('../paths.js');
    const lock = readPassportLock(passportsFileIn(stroqHome()));
    for (const [name, record] of Object.entries(lock.mcp)) {
      if (
        isRecord(record) &&
        record['kind'] === 'mcp' &&
        record['status'] === 'confirmed' &&
        isRecord(record['written']) &&
        typeof record['config'] === 'string' &&
        resolve(record['config']) === resolve(file)
      )
        confirmed.set(name, record['written']);
    }
  } catch {
    // No lock, or one that cannot be read: nothing was confirmed that could be compared.
  }
  return confirmed;
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
  const confirmed = await confirmedEntries(file);
  for (const [name, entry] of Object.entries(servers)) {
    const label = `mcp pin ${quotePath(name)}`;
    if (!isWrapperWithPin(entry)) {
      // The lock says `add` confirmed a pinned wrapper under this name, and what stands there has no pin.
      if (confirmed.has(name))
        statuses.push({
          name: label,
          ok: false,
          detail:
            'the pin was taken out of this entry, or it is not the one confirmed; start is not guarded (re-run stroq add to confirm it)',
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
    statuses.push({ name: label, ...result });
  }
  return statuses;
}
