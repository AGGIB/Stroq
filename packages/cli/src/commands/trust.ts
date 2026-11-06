import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  EMPTY_TRUST,
  loadBundledRules,
  parseTrustList,
  scanContent,
  trustDigest,
  type TrustEntry,
  type TrustList,
} from '@stroq/core';
import { topOf } from '../folder-check.js';
import { readFolder } from '../folder-reading.js';
import { readTrustedFolders, writeTrustedFolders } from '../folder-trust.js';
import { trustFile, trustedFoldersFile } from '../paths.js';

/**
 * `stroq trust <file>` — say that this content is documentation, not an instruction.
 *
 * `stroq untaint` clears a session and forgets; re-reading the same file re-taints it.
 * For a false positive on a file the agent opens every session, that is not an
 * annoyance but a session tainted from the first minute, every time — and the way
 * people escape that is by removing Stroq.
 *
 * An entry is pinned to the exact bytes: it records the sha256 of the file as it is
 * now, and the engine waives a verdict only for text with that digest, however it
 * was read — a `Read`, a `cat`, another path to the same file. Trusting a README
 * today therefore says nothing about the README in tomorrow's pull request. Every waiver is written to the audit chain as well, so an
 * exemption is a setting one can read back, not a hole.
 */
function read(file: string): TrustList {
  try {
    return parseTrustList(readFileSync(file, 'utf8'));
  } catch {
    return EMPTY_TRUST;
  }
}

function write(file: string, list: TrustList): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`);
  chmodSync(file, 0o600);
}

function add(file: string, path: string, now: () => Date): { code: number; message: string } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { code: 1, message: `stroq trust: cannot read ${path}: ${(err as Error).message}\n` };
  }
  const scan = scanContent(loadBundledRules(), text);
  // Trusting a file nothing flags would be a no-op entry that ages into a blanket
  // exemption the day the file changes, which is the shape this command exists to
  // avoid. Say so instead of writing it.
  if (scan.verdict !== 'suspect') {
    return {
      code: 0,
      message: `${path} is not flagged by any rule — nothing to trust\n`,
    };
  }
  const ruleIds = [...new Set(scan.matches.map((m) => m.ruleId))];
  const entry: TrustEntry = {
    source: path,
    sha256: trustDigest(text),
    ruleIds,
    addedAt: now().toISOString(),
  };
  const current = read(file);
  const entries = [...current.entries.filter((e) => e.source !== path), entry];
  write(file, { version: 1, entries });
  return {
    code: 0,
    message:
      `trusted ${path}\n` +
      `  rules waived: ${ruleIds.join(', ')}\n` +
      '  pinned to this exact content — any change to the file taints again\n',
  };
}

function formatList(entries: readonly TrustEntry[]): string {
  if (entries.length === 0) return 'nothing is trusted\n';
  return `${entries
    .map((e) => `${e.source}\n  ${e.sha256.slice(0, 16)}…  ${e.ruleIds.join(', ')}  ${e.addedAt}`)
    .join('\n')}\n`;
}

/** How many of a folder's places are named when it is trusted. */
const PLACES_SHOWN = 20;

/** Pins a folder to what the reading finds in it now. */
function trustFolder(dir: string): { code: number; message: string } {
  const path = resolve(dir);
  if (!existsSync(path)) {
    return { code: 1, message: `stroq trust: no such folder: ${path}\n` };
  }
  const top = topOf(path, homedir());
  const { labels, ids, notRead } = readFolder(top);
  const skipped =
    notRead.length === 0
      ? []
      : ['Not read, so not covered:', ...notRead.map((what) => `  ${what}`)];
  if (ids.length === 0) {
    return {
      code: 0,
      message: [
        `${top}: the reading points at nothing here — nothing to trust`,
        ...skipped,
        '',
      ].join('\n'),
    };
  }
  const file = trustedFoldersFile();
  writeTrustedFolders(file, { ...readTrustedFolders(file), [top]: ids });
  const more = labels.length - PLACES_SHOWN;
  return {
    code: 0,
    message: [
      `trusted ${top}, for what it holds now:`,
      ...labels.slice(0, PLACES_SHOWN).map((place) => `  ${place}`),
      ...(more > 0 ? [`  and ${more} more`] : []),
      ...skipped,
      'A change to one of these files, or anything new found here, is asked about again.',
      '',
    ].join('\n'),
  };
}

export function runTrust(argv: readonly string[], now: () => Date = () => new Date()): number {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      list: { type: 'boolean' },
      remove: { type: 'string' },
      folder: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  const file = trustFile();

  if (values.folder !== undefined) {
    const { code, message } = trustFolder(values.folder);
    process.stdout.write(message);
    return code;
  }

  if (values.remove !== undefined) {
    const path = resolve(values.remove);
    // A file that was trusted by name is what was meant, even in a folder that is trusted too.
    const current = read(file);
    const entries = current.entries.filter((e) => e.source !== path);
    if (entries.length < current.entries.length) {
      write(file, { version: 1, entries });
      process.stdout.write(`removed ${path}\n`);
      return 0;
    }
    const folders = trustedFoldersFile();
    const trusted = readTrustedFolders(folders);
    const top = topOf(path, homedir());
    if (trusted[top] !== undefined) {
      writeTrustedFolders(
        folders,
        Object.fromEntries(Object.entries(trusted).filter(([folder]) => folder !== top)),
      );
      process.stdout.write(`removed ${top}\n`);
      return 0;
    }
    process.stdout.write(`${path} was not trusted\n`);
    return 1;
  }

  if (values.list === true || positionals.length === 0) {
    const entries = read(file).entries;
    const folders = Object.keys(readTrustedFolders(trustedFoldersFile()));
    process.stdout.write(
      values.json === true
        ? `${JSON.stringify({ version: 1, entries, folders }, null, 2)}\n`
        : formatList(entries) + folders.map((folder) => `${folder}  (folder)\n`).join(''),
    );
    return 0;
  }

  const { code, message } = add(file, resolve(positionals[0] as string), now);
  process.stdout.write(message);
  return code;
}
