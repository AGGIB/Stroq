import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Content the user has judged benign after Stroq flagged it.
 *
 * `stroq untaint` clears a session; it does not remember. Re-reading the same
 * documentation re-taints immediately, so a false positive on a file the agent opens
 * every session is not a one-off annoyance — it is a session that is tainted from the
 * first minute, every time, and the way people escape that is by removing Stroq.
 *
 * An exemption list is also the first thing an attacker wants to write to, which is
 * why an entry is pinned to the exact bytes that were judged: the file it names must
 * still hash to the same value. Trusting `README.md` today therefore says nothing
 * about the `README.md` that arrives in tomorrow's pull request. The file lives under
 * `~/.stroq/`, which `SELF_CONFIG_FILE` already protects, so a tainted agent cannot
 * add to it; and a suppression is written to the audit exactly like a taint would be,
 * because an exemption nobody can see afterwards is a hole rather than a setting.
 */
export interface TrustEntry {
  /** What was being read, as the taint source records it. */
  readonly source: string;
  /** sha256 of the exact text that was scanned when this entry was added. */
  readonly sha256: string;
  /** The rules that fired on it, for the report — not part of the match. */
  readonly ruleIds: readonly string[];
  readonly addedAt: string;
}

export interface TrustList {
  readonly version: 1;
  readonly entries: readonly TrustEntry[];
}

export const EMPTY_TRUST: TrustList = { version: 1, entries: [] };

export const trustDigest = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

export interface TrustStore {
  /** True when this exact content, from this exact source, was judged benign. */
  trusts(source: string, text: string): boolean;
  list(): readonly TrustEntry[];
}

export function parseTrustList(raw: string): TrustList {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_TRUST;
  }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY_TRUST;
  const { version, entries } = parsed as Partial<TrustList>;
  // A list this build cannot read is treated as empty rather than as trust: failing
  // closed here means an unreadable file costs a false positive, not a missed taint.
  if (version !== 1 || !Array.isArray(entries)) return EMPTY_TRUST;
  return {
    version: 1,
    entries: entries.filter(
      (e): e is TrustEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as TrustEntry).source === 'string' &&
        typeof (e as TrustEntry).sha256 === 'string',
    ),
  };
}

export class FileTrustStore implements TrustStore {
  private cache: TrustList | null = null;

  constructor(private readonly file: string) {}

  private load(): TrustList {
    if (this.cache) return this.cache;
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      this.cache = EMPTY_TRUST;
      return this.cache;
    }
    this.cache = parseTrustList(raw);
    return this.cache;
  }

  trusts(source: string, text: string): boolean {
    if (source === '') return false;
    const digest = trustDigest(text);
    return this.load().entries.some((e) => e.source === source && e.sha256 === digest);
  }

  list(): readonly TrustEntry[] {
    return this.load().entries;
  }
}
