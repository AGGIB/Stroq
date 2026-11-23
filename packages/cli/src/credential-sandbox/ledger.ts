import { timingSafeEqual } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { parseJsonDocument } from '../harden/json-doc.js';
import { readTargetStrict } from '../harden/read.js';
import { ensureStateMacKeySync, readStateMacKeySync, stateMac } from '../state-mac.js';
import { KEY_PATHS, RULE_IDS, type OwnedRule } from './rules.js';

/**
 * The record of what `stroq init` wrote into one Claude Code settings file, kept under
 * `<stroq home>/sandbox/`. `stroq uninstall` removes only what it names.
 *
 * It carries a tag made with the home's state key (`state-mac.ts`) over its own content and the
 * settings file it is for. A record with no tag, a wrong one, or one made for another file is not
 * acted on: it is read as a record that is not there. That is evidence of a change made without the
 * key, with the limits `state-mac.ts` gives: a process that can read or replace the key can sign a
 * record, and an older record this home signed still verifies when it is put back.
 */

const MAX_LINK_LENGTH = 4096;
const link = z
  .string()
  .min(2)
  .max(MAX_LINK_LENGTH)
  .refine((path) => path.startsWith('~/') || isAbsolute(path));
const keyPaths: readonly string[] = KEY_PATHS;
const ownedRules = z
  .array(
    z
      .object({
        id: z.enum(RULE_IDS),
        created: z.number().int().min(0).max(3),
        previous: z.literal(false).nullable(),
        link: link.optional(),
      })
      .strict()
      .refine((e) => e.previous === null || e.id === 'enabled')
      .refine((e) => e.link === undefined || keyPaths.includes(e.id)),
  )
  // A key path can have a record for each place its link has pointed to.
  .max(RULE_IDS.length * 4)
  .refine((rules) => new Set(rules.map((r) => r.id + '\n' + (r.link ?? ''))).size === rules.length);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const body = z
  .object({
    version: z.literal(1),
    owned: ownedRules,
    pending: z
      .object({ before: digest.nullable(), after: digest, owned: ownedRules })
      .strict()
      .optional(),
  })
  .strict();
const signed = body.extend({ mac: digest }).strict();

export interface LedgerBody {
  readonly owned: readonly OwnedRule[];
  readonly pending?: {
    readonly before: string | null;
    readonly after: string;
    readonly owned: readonly OwnedRule[];
  };
}

export type Ledger =
  /** No record: nothing in the file is known to be Stroq's. */
  | { readonly kind: 'none' }
  | { readonly kind: 'ok'; readonly owned: readonly OwnedRule[] }
  /** A record that does not parse or does not verify. It is left where it is. */
  | { readonly kind: 'unverified' }
  /** A write was interrupted and the settings are neither the text before it nor the text after. */
  | { readonly kind: 'unresolved' };

/** What the schema reads, where a missing `link` may be spelled as an undefined one. */
type ParsedRule = Omit<OwnedRule, 'link'> & { readonly link?: string | undefined };

const plain = (rules: readonly ParsedRule[]): OwnedRule[] =>
  rules.map(({ id, created, previous, link: to }) => ({
    id,
    created,
    previous,
    ...(to === undefined ? {} : { link: to }),
  }));

/** One spelling of a record, so that the tag does not depend on how the file was laid out. */
function canonical(record: LedgerBody): string {
  const { pending } = record;
  return JSON.stringify({
    version: 1,
    owned: plain(record.owned),
    ...(pending === undefined
      ? {}
      : { pending: { before: pending.before, after: pending.after, owned: plain(pending.owned) } }),
  });
}

const domain = (target: string): string => 'credential-sandbox-ledger/' + target;

/** The text of a record for the settings file whose digest is `target`, signed with this home's key. */
export function sealLedger(home: string, target: string, record: LedgerBody): string {
  const text = canonical(record);
  const mac = stateMac(ensureStateMacKeySync(home), domain(target), text);
  return JSON.stringify({ ...JSON.parse(text), mac }) + '\n';
}

function verified(home: string, target: string, text: string): LedgerBody | null {
  const file = parseJsonDocument(text);
  const result = signed.safeParse(file.ok ? file.doc : null);
  if (!result.success) return null;
  const { mac, owned, pending } = result.data;
  const record: LedgerBody = {
    owned: plain(owned),
    ...(pending === undefined ? {} : { pending: { ...pending, owned: plain(pending.owned) } }),
  };
  let key: Buffer | null;
  try {
    key = readStateMacKeySync(home);
  } catch {
    // A key that is not private cannot vouch for anything.
    return null;
  }
  if (key === null) return null;
  const expected = Buffer.from(stateMac(key, domain(target), canonical(record)), 'hex');
  return timingSafeEqual(expected, Buffer.from(mac, 'hex')) ? record : null;
}

/**
 * What the record at `receipt` says about a settings file whose text now has the digest
 * `fingerprint` (null for a file that is not there).
 */
export function readLedger(
  home: string,
  receipt: string,
  target: string,
  fingerprint: string | null,
): Ledger {
  const text = readTargetStrict(receipt);
  if (text === null) return { kind: 'none' };
  const record = verified(home, target, text);
  if (record === null) return { kind: 'unverified' };
  // With the settings file gone there is nothing left in it to own.
  if (fingerprint === null) return { kind: 'ok', owned: [] };
  const { pending } = record;
  if (pending === undefined || pending.before === fingerprint)
    return { kind: 'ok', owned: record.owned };
  if (pending.after === fingerprint) return { kind: 'ok', owned: pending.owned };
  return { kind: 'unresolved' };
}
