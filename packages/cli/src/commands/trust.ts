import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { trustFile } from '../paths.js';

/**
 * `stroq trust <file>` — say that this content is documentation, not an instruction.
 *
 * `stroq untaint` clears a session and forgets; re-reading the same file re-taints it.
 * For a false positive on a file the agent opens every session, that is not an
 * annoyance but a session tainted from the first minute, every time — and the way
 * people escape that is by removing Stroq.
 *
 * An entry is pinned to the exact bytes: it records the sha256 of the file as it is
 * now, and the engine waives a verdict only when both the source and the digest
 * match. Trusting a README today therefore says nothing about the README in
 * tomorrow's pull request. Every waiver is written to the audit chain as well, so an
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

export function runTrust(argv: readonly string[], now: () => Date = () => new Date()): number {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { list: { type: 'boolean' }, remove: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
  });
  const file = trustFile();

  if (values.remove !== undefined) {
    const path = resolve(values.remove);
    const current = read(file);
    const entries = current.entries.filter((e) => e.source !== path);
    if (entries.length === current.entries.length) {
      process.stdout.write(`${path} was not trusted\n`);
      return 1;
    }
    write(file, { version: 1, entries });
    process.stdout.write(`removed ${path}\n`);
    return 0;
  }

  if (values.list === true || positionals.length === 0) {
    const entries = read(file).entries;
    process.stdout.write(
      values.json === true
        ? `${JSON.stringify({ version: 1, entries }, null, 2)}\n`
        : formatList(entries),
    );
    return 0;
  }

  const { code, message } = add(file, resolve(positionals[0] as string), now);
  process.stdout.write(message);
  return code;
}
