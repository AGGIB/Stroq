// The keys a run of the card looked for, as one digest and one numbering.
//
// A result kept for a transcript is true only for the keys it was checked against: a key added since
// may be in that transcript. So the cache is keyed by a digest of everything the check judged under:
// each key's name, where it was read, the other places it was read, whether it is a canary, and the
// SHA-256 of its value; the MCP servers a call may have gone to; and the home folder. The digest is
// scrypt over those lines with a random salt that is kept beside it, so the digest is the same on the
// next run and an old one is a miss, and so a value cannot be read back from it: what is kept is one
// digest of the whole index, never a hash of one value, and the hash of each value lives in this
// process only.
//
// The same sorted lines give each key a number that does not depend on the order the key files were
// read in. What is kept for a transcript says "key 17", not the key, and the digest says which 17.
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import type { Key } from '../sent/keys.js';
import type { McpServer } from '../sent/mcp-config.js';

/** The index as a worker needs it: plain data, handed to a thread once. Holds values; never kept. */
export interface KeyIndexData {
  readonly home: string;
  readonly keys: readonly Key[];
  /** The MCP servers the sessions' calls are placed by, as `McpServers.known` holds them. */
  readonly mcp: readonly (readonly [string, McpServer])[];
}

export interface PreparedIndex {
  readonly data: KeyIndexData;
  /** A key's number, by its place in `data.keys`. */
  readonly idOf: readonly number[];
  /** A key's place in `data.keys`, by its number. */
  readonly indexOf: readonly number[];
  /** The lines the digest is made of: in this process only. */
  readonly lines: readonly string[];
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** One key, as the digest sees it. Holds the hash of the value, so it never leaves this process. */
const lineOf = (key: Key): string =>
  JSON.stringify([
    key.name,
    key.source,
    [...(key.alsoIn ?? [])].sort(),
    key.canary === true,
    sha256(key.value),
  ]);

/** The numbering and the lines of an index. */
export function prepareIndex(data: KeyIndexData): PreparedIndex {
  const lines = data.keys.map(lineOf);
  const order = lines
    .map((_, i) => i)
    .sort((a, b) => ((lines[a] as string) < (lines[b] as string) ? -1 : 1));
  const idOf: number[] = [];
  order.forEach((place, id) => {
    idOf[place] = id;
  });
  const mcp = [...data.mcp]
    .map(([name, server]) => JSON.stringify([name, server.remote, server.host]))
    .sort();
  return {
    data,
    idOf,
    indexOf: order,
    lines: [
      JSON.stringify({ v: 1, home: data.home, mcp }),
      ...order.map((i) => lines[i] as string),
    ],
  };
}

/** A salt for a cache that has none: 16 random bytes. */
export const newSalt = (): string => randomBytes(16).toString('hex');

/** The digest of an index under a salt: 64 hexadecimal characters. */
export function indexDigest(index: PreparedIndex, salt: string): string {
  return scryptSync(index.lines.join('\n'), Buffer.from(salt, 'hex'), 32, {
    N: 16_384,
    r: 8,
    p: 1,
  }).toString('hex');
}
