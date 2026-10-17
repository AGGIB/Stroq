// Which MCP servers the lock holds as pinned, and what that means for a run under the sandbox.
//
// A pinned server runs from a private copy under `<stroq home>/run`, and `stroq run --sandbox` denies writes
// there (the folder is one that Node looks a package up in, and an agent that could write it could plant one).
// So a pinned server cannot make its copy inside the sandbox and does not start there. That follows from the
// deny; it has not been measured with a real srt. `stroq run` and `stroq doctor` say it when there is such a server.
import { passportsFileIn } from '../paths.js';

/** The names of the servers the lock holds as confirmed and pinned, sorted; none when the lock cannot be read. */
export async function pinnedServers(home: string): Promise<string[]> {
  try {
    // Loaded here and not at the top: the hooks load the files that call this, and must not load the lock reader.
    const { McpPinSchema, readPassportLock } = await import('../install/lock-reader.js');
    const lock = readPassportLock(passportsFileIn(home));
    return Object.entries(lock.mcp)
      .filter(([, record]) => McpPinSchema.safeParse(record).success)
      .map(([name]) => name)
      .sort();
  } catch {
    // No lock, or one that cannot be read: nothing is known to be pinned.
    return [];
  }
}

/** The sentence for a run under the sandbox and for doctor. `shown` is the names, already made safe to print. */
export function sandboxPinNote(shown: string, count: number, home: string): string {
  return `${count === 1 ? '1 pinned MCP server' : `${count} pinned MCP servers`} (${shown}) keep a verified copy under ${home}/run, which the sandbox denies writes to, so ${count === 1 ? 'it' : 'they'} cannot start inside \`stroq run --sandbox\` (this follows from the deny and was not measured with a real srt): start the client without --sandbox, or run ${count === 1 ? 'that server' : 'those servers'} outside it`;
}
