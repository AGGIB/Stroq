import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { installRecordFile } from '../paths.js';

/**
 * What `stroq init` wrote, so `stroq doctor` can tell an installed hook from a
 * replaced one.
 *
 * Every check before this one asked whether *some* handler claims to be Stroq —
 * `isStroqHandler` matches a command ending in ` hook claude-code`. That is a test of
 * intent, not of identity: an entry rewritten to `/tmp/evil hook claude-code` passes
 * it. The distinction stopped being theoretical with the ChainDrop npm worm
 * (2026-08-04), whose payload writes hook entries into Claude Code's own settings.
 *
 * The record holds what was installed and nothing about the machine: one command
 * string per agent and scope. It is advisory by construction — an attacker who can
 * rewrite the agent's config can rewrite this too — so it detects a modification
 * rather than preventing one, and `doctor` says so in those words.
 */
export interface InstallEntry {
  readonly command: string;
  readonly recordedAt: string;
}

export interface InstallRecord {
  readonly version: 1;
  readonly entries: Readonly<Record<string, InstallEntry>>;
}

const EMPTY: InstallRecord = { version: 1, entries: {} };

export const installKey = (agent: string, scope: string): string => `${agent}:${scope}`;

export function readInstallRecord(file: string = installRecordFile()): InstallRecord {
  if (!existsSync(file)) return EMPTY;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as InstallRecord;
    // A record this version does not understand is treated as absent rather than as
    // drift: reporting every hook as changed because the file grew a field would
    // train people to ignore the one time it matters.
    return parsed.version === 1 && typeof parsed.entries === 'object' && parsed.entries !== null
      ? parsed
      : EMPTY;
  } catch {
    return EMPTY;
  }
}

export function recordInstall(
  agent: string,
  scope: string,
  command: string,
  file: string = installRecordFile(),
): void {
  const current = readInstallRecord(file);
  const next: InstallRecord = {
    version: 1,
    entries: {
      ...current.entries,
      [installKey(agent, scope)]: { command, recordedAt: new Date().toISOString() },
    },
  };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  chmodSync(file, 0o600);
}

/**
 * Whether the config still carries the command `init` recorded for it.
 *
 * Compared against the file's raw text rather than its parsed shape, so one check
 * covers JSON and TOML alike. The command is quoted, and a JSON config escapes those
 * quotes, so both spellings count as present — the escaped form is what the file
 * actually holds, and the raw form is what a TOML config holds.
 */
export type InstallDrift = 'unrecorded' | 'intact' | 'changed';

export function installDrift(
  agent: string,
  scope: string,
  configText: string,
  record: InstallRecord = readInstallRecord(),
): InstallDrift {
  const entry = record.entries[installKey(agent, scope)];
  if (!entry) return 'unrecorded';
  const escaped = JSON.stringify(entry.command).slice(1, -1);
  return configText.includes(entry.command) || configText.includes(escaped) ? 'intact' : 'changed';
}
