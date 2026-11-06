// The folders a person has read and said are fine, each for what it held then.
//
// `stroq trust --folder` is the way out of the question `folder-check.ts` asks, for a project that
// does what honest projects rarely do: a security tool whose tests hold attack strings, say. An entry
// holds one id for each place, made from what the file holds, so a change to one of those files asks
// again, as `stroq trust <file>` does for a file. It is the person's to write: the state gate refuses
// the command through an agent's shell, and the file lies under `~/.stroq`, which the self-tamper gate
// covers. Both read text, so they are limits on an agent and not walls.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readRegularFile } from '@stroq/core';

const RECORD_MAX = 4 * 1024 * 1024;

export type TrustedFolders = Readonly<Record<string, readonly string[]>>;

const isIdList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((id) => typeof id === 'string');

/** The trusted folders and what each held. A record that cannot be read trusts nothing. */
export function readTrustedFolders(file: string): TrustedFolders {
  try {
    const read = readRegularFile(file, RECORD_MAX, { noFollow: true });
    if (read.kind !== 'text') return {};
    const value: unknown = JSON.parse(read.text);
    if (typeof value !== 'object' || value === null) return {};
    const { folders } = value as Record<string, unknown>;
    if (typeof folders !== 'object' || folders === null) return {};
    const kept = Object.entries(folders).filter((entry): entry is [string, readonly string[]] =>
      isIdList(entry[1]),
    );
    return Object.fromEntries(kept);
  } catch {
    return {};
  }
}

export function writeTrustedFolders(file: string, folders: TrustedFolders): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify({ version: 1, folders }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}
