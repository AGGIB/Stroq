import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ActionClass, Decision } from '../types.js';
import { withLock } from '../util/lock.js';

export interface AuditEntryInput {
  readonly sessionId: string;
  readonly phase: 'pre' | 'post';
  readonly tool: string;
  readonly summary: string;
  readonly classes?: readonly ActionClass[];
  readonly decision?: Decision;
  readonly scan?: {
    readonly verdict: string;
    readonly score: number;
    readonly ruleIds: readonly string[];
  };
}

export interface AuditEntry extends AuditEntryInput {
  readonly seq: number;
  readonly ts: string;
  readonly prevHash: string;
  readonly hash: string;
}

export const GENESIS_HASH = '0'.repeat(64);
const MAX_SUMMARY = 300;
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
];

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, '[REDACTED]'), text);
}

export function hashEntry(entry: Omit<AuditEntry, 'hash'>): string {
  const { hash: _ignored, ...rest } = entry as AuditEntry;
  return createHash('sha256').update(stableStringify(rest)).digest('hex');
}

export class AuditLog {
  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async readAll(): Promise<AuditEntry[]> {
    try {
      const raw = await readFile(this.file, 'utf8');
      return raw
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as AuditEntry);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async append(input: AuditEntryInput): Promise<AuditEntry> {
    await mkdir(dirname(this.file), { recursive: true });
    return withLock(`${this.file}.lock`, async () => {
      const entries = await this.readAll();
      const last = entries[entries.length - 1];
      const summary = redact(input.summary).slice(0, MAX_SUMMARY);
      const unhashed: Omit<AuditEntry, 'hash'> = {
        ...input,
        summary,
        seq: (last?.seq ?? 0) + 1,
        ts: this.now().toISOString(),
        prevHash: last?.hash ?? GENESIS_HASH,
      };
      const entry: AuditEntry = { ...unhashed, hash: hashEntry(unhashed) };
      await appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
      return entry;
    });
  }

  async verify(): Promise<{ ok: boolean; count: number; brokenAt: number | null }> {
    const entries = await this.readAll();
    let prev = GENESIS_HASH;
    for (const entry of entries) {
      const { hash, ...rest } = entry;
      if (entry.prevHash !== prev || hashEntry(rest) !== hash) {
        return { ok: false, count: entries.length, brokenAt: entry.seq };
      }
      prev = hash;
    }
    return { ok: true, count: entries.length, brokenAt: null };
  }
}
