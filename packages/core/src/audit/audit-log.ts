import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ActionClass, Decision, ProvenanceEvidence } from '../types.js';
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
  /** Provenance evidence that contributed `origin.*` classes to `decision`. */
  readonly provenance?: readonly ProvenanceEvidence[];
}

export interface AuditEntry extends AuditEntryInput {
  readonly seq: number;
  readonly ts: string;
  readonly prevHash: string;
  readonly hash: string;
}

export const GENESIS_HASH = '0'.repeat(64);
const MAX_SUMMARY = 300;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

interface RedactionRule {
  readonly re: RegExp;
  readonly replace: string;
}

// Applied in order: vendor-specific token shapes first, then structural
// patterns (labelled credentials, basic-auth flags, URL userinfo), and
// finally the long-opaque-token guard. Each pattern's own replacement
// keeps any surrounding label/scheme so the audit trail stays readable.
const STRUCTURAL_REDACTIONS: readonly RedactionRule[] = [
  { re: /\bsk-[A-Za-z0-9_-]{10,}/g, replace: '[REDACTED]' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: '[REDACTED]' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: '[REDACTED]' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: '[REDACTED]' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, replace: '[REDACTED]' },
  { re: /\bAIza[0-9A-Za-z_-]{30,}\b/g, replace: '[REDACTED]' },
  // Authorization: Bearer|Basic|Token <value> — keep the scheme.
  { re: /(authorization\s*:\s*)(bearer|basic|token)\s+\S+/gi, replace: '$1$2 [REDACTED]' },
  // Labelled credentials: x-api-key / api-key / token / secret / password / pwd = or : value.
  {
    re: /((?:x-api-key|api[-_]?key|token|secret|password|passwd|pwd)\s*[:=]\s*)\S+/gi,
    replace: '$1[REDACTED]',
  },
  // `curl -u user:pass` / `--user user:pass` — drop the whole flag+value,
  // except `-u uid:gid` (both sides all digits), e.g. `docker run -u 1000:1000`.
  {
    re: /(-u|--user)\s+(?!\d+:\d+(?:\s|$))\S+:\S+/g,
    replace: '[REDACTED]',
  },
  // URL userinfo: scheme://user:pass@host
  { re: /:\/\/[^\s/:@]+:[^\s/@]+@/g, replace: '://[REDACTED]@' },
];

// Guard applied last: a standalone opaque token of 32+ chars (letters,
// digits, `.`/`-`/`_`, no spaces or slashes) that mixes letters and digits.
// Pure-hex tokens up to 64 chars are exempt (git SHAs are not secrets), and
// the charset excludes `/` so file paths and URLs are never matched.
const LONG_TOKEN = /(?<![A-Za-z0-9._-])[A-Za-z0-9._-]{32,}(?![A-Za-z0-9._-])/g;
const isPureHex = (token: string): boolean => /^[0-9a-fA-F]+$/.test(token);
const hasLetterAndDigit = (token: string): boolean => /[A-Za-z]/.test(token) && /[0-9]/.test(token);
// Whitespace-delimited words that look like identifiers rather than secrets
// are exempt entirely, even if a substring of them would otherwise match
// LONG_TOKEN: file paths (contain `/`), scoped package names (start with
// `@`), and file names (end in a short extension).
const FILE_EXTENSION = /\.[A-Za-z0-9]{1,5}$/;
const isExemptWord = (word: string): boolean =>
  word.includes('/') || word.startsWith('@') || FILE_EXTENSION.test(word);

function redactLongTokenSpans(word: string): string {
  return word.replace(LONG_TOKEN, (token) => {
    if (isPureHex(token) && token.length <= 64) return token;
    if (!hasLetterAndDigit(token)) return token;
    return '[REDACTED]';
  });
}

function redactLongTokens(text: string): string {
  return text
    .split(/(\s+)/)
    .map((word) => (isExemptWord(word) ? word : redactLongTokenSpans(word)))
    .join('');
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v === undefined ? null : v)).join(',')}]`;
  }
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
  const structural = STRUCTURAL_REDACTIONS.reduce(
    (acc, { re, replace }) => acc.replace(re, replace),
    text,
  );
  return redactLongTokens(structural);
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
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    return lines.map((line, i) => {
      try {
        return JSON.parse(line) as AuditEntry;
      } catch (err) {
        throw new Error(`corrupt audit line ${i + 1}: ${this.file}`, { cause: err });
      }
    });
  }

  async append(input: AuditEntryInput): Promise<AuditEntry> {
    await mkdir(dirname(this.file), { recursive: true, mode: PRIVATE_DIR_MODE });
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
      await appendFile(this.file, `${JSON.stringify(entry)}\n`, {
        encoding: 'utf8',
        mode: PRIVATE_FILE_MODE,
      });
      return entry;
    });
  }

  /**
   * Verifies the hash chain across all entries.
   *
   * The chain proves that surviving entries are internally consistent: an
   * edit, reorder, or mid-log deletion of any entry breaks the
   * `prevHash`/`hash` links and is detected here. However, deleting
   * entries from the END of the file is NOT detectable this way — a
   * truncated log whose remaining prefix is untouched still verifies as
   * `ok: true` with a smaller `count`. Signed checkpoints (anchoring
   * `count` to an external, tamper-evident record) are a planned later
   * feature. Callers who need protection against truncation must compare
   * the returned `count` against an independently known expected value.
   */
  async verify(): Promise<{ ok: boolean; count: number; brokenAt: number | null }> {
    let entries: AuditEntry[];
    try {
      entries = await this.readAll();
    } catch (err) {
      const match = err instanceof Error ? /corrupt audit line (\d+)/.exec(err.message) : null;
      if (!match) throw err;
      const raw = await readFile(this.file, 'utf8');
      const count = raw.split('\n').filter((l) => l.trim().length > 0).length;
      return { ok: false, count, brokenAt: Number(match[1]) };
    }
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
