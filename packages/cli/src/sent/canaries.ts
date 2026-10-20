// Canaries planted with `stroq canary`: decoy values no task needs, so one found in a session is
// the clearest sign that something steered the agent.
//
// Their values are not stored anywhere Stroq keeps: `secrets.json` holds a salted hash of each.
// The value itself is in the decoy files `stroq canary --file` planted, which `canary-files.json`
// lists by path, or in whatever file the user pasted a canary line into. `sent` reads the decoy
// files as it reads key files, and knows a canary in any file it reads by its shape. A canary
// that is in no such file (the user pasted it somewhere `sent` does not read, or deleted the
// decoy) is looked for in the sessions themselves: each value of a canary's shape there is
// hashed with the salt and compared with the planted hashes (`session-canaries.ts`). Every read
// here is a read; nothing is written.
import { closeSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { hashSecret, readRegularFile } from '@stroq/core';
import { openRegularFile } from './regular-file.js';

/** What every canary starts with: documented, not secret. */
export const CANARY_PREFIX = 'stroq_canary_';
const PREFIX = CANARY_PREFIX;
/** `stroq canary` draws this many letters and digits after the prefix. */
const DRAWN = 32;
/** A registry or an index larger than this is not one `stroq canary` wrote. */
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const MAX_DECOYS = 256;

const isAlnum = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a);

/** Whether a value has the shape of a canary `stroq canary` made. */
export function isCanaryValue(value: string): boolean {
  if (value.length !== PREFIX.length + DRAWN || !value.startsWith(PREFIX)) return false;
  for (let i = PREFIX.length; i < value.length; i += 1)
    if (!isAlnum(value.charCodeAt(i))) return false;
  return true;
}

/** A canary in a decoy file's `NAME=value` lines. */
export interface FoundCanary {
  readonly name: string;
  readonly value: string;
}

const unquote = (text: string): string => text.trim().replace(/^["']|["']$/g, '');

/** The canaries in a decoy file's text, by its `NAME=value` lines. */
export function canariesIn(text: string): FoundCanary[] {
  return text.split('\n').flatMap((line) => {
    const eq = line.indexOf('=');
    if (eq < 0) return [];
    const value = unquote(line.slice(eq + 1));
    const name = line
      .slice(0, eq)
      .replace(/^\s*export\s+/, '')
      .trim();
    return isCanaryValue(value) ? [{ name: name === '' ? 'STROQ_CANARY_KEY' : name, value }] : [];
  });
}

/** A JSON file Stroq keeps, parsed, or null when it is missing, too large or not JSON. */
function readStore(path: string): unknown {
  try {
    const read = readRegularFile(path, MAX_STORE_BYTES);
    return read.kind === 'text' ? (JSON.parse(read.text) as unknown) : null;
  } catch {
    return null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The decoy files `stroq canary --file` planted, as `canary-files.json` lists them. */
export function decoyFiles(stroqHome: string): string[] {
  const store = readStore(join(stroqHome, 'canary-files.json'));
  const files = isRecord(store) ? store['files'] : null;
  return Array.isArray(files)
    ? files.filter((f): f is string => typeof f === 'string').slice(0, MAX_DECOYS)
    : [];
}

/**
 * How many canaries `secrets.json` records whose value is none of `values`: planted, but in no
 * file this run read, so not looked for.
 */
export function canariesNotFound(stroqHome: string, values: readonly string[]): number {
  const planted = plantedCanaries(stroqHome);
  if (planted === null) return 0;
  const known = new Set(values.map((v) => hashSecret(planted.salt, v)));
  return [...planted.names.keys()].filter((hash) => !known.has(hash)).length;
}

/** What `secrets.json` records of the canaries planted: the salt, and each one's name by hash. */
export interface PlantedCanaries {
  readonly salt: string;
  /** Hash → the name it was planted under, as written there: not yet checked for its shape. */
  readonly names: ReadonlyMap<string, string>;
}

/** The canaries `stroq canary` planted, or null when it recorded none that can be read. */
export function plantedCanaries(stroqHome: string): PlantedCanaries | null {
  const store = readStore(join(stroqHome, 'secrets.json'));
  if (!isRecord(store) || typeof store['salt'] !== 'string') return null;
  const names = new Map<string, string>();
  for (const c of Array.isArray(store['canaries']) ? store['canaries'] : []) {
    if (!isRecord(c) || typeof c['hash'] !== 'string') continue;
    names.set(c['hash'], typeof c['name'] === 'string' ? c['name'] : 'STROQ_CANARY_KEY');
  }
  return { salt: store['salt'], names };
}

const PREFIX_BYTES = Buffer.from(PREFIX, 'latin1');
/** `stroq_canary_` and the letters and digits after it. */
const VALUE_BYTES = PREFIX.length + DRAWN;
/** Bytes read at a time from a session file. */
const READ_CHUNK = 4 * 1024 * 1024;

/**
 * Hands `found` each value of a canary's shape in `buf[0..end)` that starts before `limit`, until
 * `found` says to stop (false). One pass of `indexOf` for the prefix: nothing backtracks.
 */
function shapesIn(
  buf: Buffer,
  end: number,
  limit: number,
  found: (value: string) => boolean,
): boolean {
  const text = buf.subarray(0, end);
  for (let at = text.indexOf(PREFIX_BYTES); at >= 0 && at < limit;) {
    let drawn = 0;
    while (drawn < DRAWN && isAlnum(text[at + PREFIX.length + drawn] ?? 0)) drawn += 1;
    if (drawn === DRAWN && !found(text.toString('latin1', at, at + VALUE_BYTES))) return false;
    at = text.indexOf(PREFIX_BYTES, at + 1);
  }
  return true;
}

/**
 * Hands `found` each value of a canary's shape in a file, read a piece at a time, until `found`
 * says to stop. False when it stopped early. A file that cannot be read gives nothing.
 */
export function canaryValuesInFile(
  path: string,
  found: (value: string) => boolean,
  chunk: number = READ_CHUNK,
): boolean {
  // A FIFO or a device is refused, never waited on.
  const fd = openRegularFile(path);
  if (fd === null) return true;
  // A value that starts in the last bytes of a read may end in the next one: they are kept.
  const keep = VALUE_BYTES - 1;
  const buf = Buffer.allocUnsafe(Math.max(1, chunk) + keep);
  let filled = 0;
  try {
    for (;;) {
      const n = readSync(fd, buf, filled, buf.length - filled, null);
      filled += n;
      if (n === 0) return shapesIn(buf, filled, filled, found);
      if (filled < buf.length) continue;
      const limit = filled - keep;
      if (!shapesIn(buf, filled, limit, found)) return false;
      buf.copyWithin(0, limit, filled);
      filled = keep;
    }
  } catch {
    return true;
  } finally {
    closeSync(fd);
  }
}

/** `canaryValuesInFile` for a text already read, such as a Cursor row. */
export function canaryValuesInText(text: string, found: (value: string) => boolean): boolean {
  const buf = Buffer.from(text, 'utf8');
  return shapesIn(buf, buf.length, buf.length, found);
}
