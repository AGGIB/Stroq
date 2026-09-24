import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * What changed among the files an agent loads as instructions — skills, subagents,
 * slash commands, `CLAUDE.md` and the rest — since the last `stroq exposure`.
 *
 * A malicious skill does not have to arrive under a new name: an update that swaps
 * the text of one already installed is the same file with new content, and a scan
 * that only reports what trips a rule today says nothing about what changed
 * yesterday. So each run records the sha256 of every file it read, and the next one
 * names what appeared and what changed. Not a finding and not an exit code: editing
 * `CLAUDE.md` is ordinary work, and a check that fails whenever you do is one people
 * turn off. It is the list to read after an update you did not make yourself.
 */
export interface Drift {
  /** True on the first run: everything was recorded and nothing is new yet. */
  readonly baseline: boolean;
  readonly added: readonly string[];
  readonly changed: readonly string[];
}

type Digests = Readonly<Record<string, string>>;

/**
 * The recorded digests, or null when there is no usable record — missing, not JSON,
 * or not the shape written below. Null means "no baseline", never "an empty machine":
 * reading a damaged file as empty would report every skill as new, which is noise
 * that teaches the reader to skip the list.
 */
export function readInventory(file: string): Digests | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const files = (parsed as { files?: unknown }).files;
  if (files === null || typeof files !== 'object' || Array.isArray(files)) return null;
  const entries = Object.entries(files as Record<string, unknown>);
  if (!entries.every(([, digest]) => typeof digest === 'string')) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

export function compareInventory(previous: Digests | null, current: Digests): Drift {
  if (previous === null) return { baseline: true, added: [], changed: [] };
  const added: string[] = [];
  const changed: string[] = [];
  for (const [path, digest] of Object.entries(current)) {
    const before = previous[path];
    if (before === undefined) added.push(path);
    else if (before !== digest) changed.push(path);
  }
  return { baseline: false, added, changed };
}

/**
 * Written through a temporary file and a rename, so an interrupted run leaves the
 * previous record rather than half of a new one; readable only by the user, like
 * everything else in `~/.stroq`.
 */
export function writeInventory(file: string, current: Digests): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, files: current }, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}
