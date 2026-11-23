import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { within } from '../commands/config-file.js';
import { z } from 'zod';
import { withConfigurationLock } from '../config-lock.js';
import { assertWriteAllowed, removeFile, writeFileAtomic } from '../harden/atomic.js';
import { deepEqual, parseJsonDocument, serializeJson } from '../harden/json-doc.js';
import { readTargetStrict } from '../harden/read.js';
import type { JsonObject } from '../harden/types.js';
import { addRules, removeRules, RULE_IDS, type OwnedRule, type SandboxChoices } from './rules.js';

const ownedRules = z
  .array(
    z
      .object({
        id: z.enum(RULE_IDS),
        created: z.number().int().min(0).max(3),
        previous: z.literal(false).nullable(),
      })
      .strict()
      .refine((e) => e.previous === null || e.id === 'enabled'),
  )
  .max(RULE_IDS.length)
  .refine((rules) => new Set(rules.map((r) => r.id)).size === rules.length);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const journal = z
  .object({
    version: z.literal(1),
    owned: ownedRules,
    pending: z
      .object({ before: digest.nullable(), after: digest, owned: ownedRules })
      .strict()
      .optional(),
  })
  .strict();

interface EditOptions {
  readonly file: string;
  readonly home: string;
  readonly dryRun: boolean;
  readonly choices: SandboxChoices | 'remove' | 'hooks-only';
  readonly hooks: (doc: JsonObject) => JsonObject;
}

/** The two atomic renames are journalled so an interrupted install or removal can be retried. */
export async function editClaudeSettings(options: EditOptions) {
  const { file, home, dryRun, choices, hooks } = options;
  const edit = async () => {
    const root = within(resolve(file), homedir()) ? homedir() : dirname(resolve(file));
    const target = assertWriteAllowed(file, { root });
    const receipt = join(home, 'sandbox', hash(target) + '.json');
    const receiptRules = { root: home, initRule: false };
    if (choices !== 'hooks-only') assertWriteAllowed(receipt, receiptRules);
    const before = readTargetStrict(file);
    const parsed = parseJsonDocument(before ?? '');
    if (!parsed.ok) throw new Error('Cannot edit Claude Code settings: ' + parsed.detail);
    const fingerprint = before === null ? null : hash(before);
    const saved = choices === 'hooks-only' ? null : readTargetStrict(receipt);
    let owned: OwnedRule[] = [];
    if (saved !== null) {
      const file = parseJsonDocument(saved);
      const result = journal.safeParse(file.ok ? file.doc : null);
      if (!result.success) throw new Error('Cannot verify the Stroq sandbox ownership record.');
      const { pending, owned: previous } = result.data;
      if (pending === undefined || pending.before === fingerprint) owned = previous;
      else if (pending.after === fingerprint) owned = pending.owned;
      // An outside edit during an interrupted transaction makes ownership ambiguous.
      // In that case leave the existing entries with their owner.
    }
    if (before === null) owned = [];
    const next =
      choices === 'remove'
        ? { doc: removeRules(parsed.doc, owned), owned: [] }
        : choices === 'hooks-only'
          ? { doc: parsed.doc, owned }
          : addRules(parsed.doc, owned, choices);
    const doc = hooks(next.doc);
    const changed = !deepEqual(doc, parsed.doc);
    const after = serializeJson(doc, parsed.layout);
    const result = {
      doc,
      changed,
      removedRules: choices === 'remove' && !deepEqual(next.doc, parsed.doc),
    };
    if (dryRun) return result;
    const checkTarget = () => {
      if (assertWriteAllowed(file, { root }) !== target || readTargetStrict(file) !== before)
        throw new Error('Claude Code settings changed during the edit. Run the command again.');
    };
    const writeRecord = (value: z.infer<typeof journal>) =>
      writeFileAtomic(receipt, JSON.stringify(value) + '\n', receiptRules);
    const tracking = saved !== null || next.owned.length > 0;
    if (changed) {
      if (tracking)
        await writeRecord({
          version: 1,
          owned,
          pending: { before: fingerprint, after: hash(after), owned: next.owned },
        });
      await writeFileAtomic(file, after, { root, beforeRename: checkTarget });
    }
    if (tracking) {
      if (next.owned.length > 0) await writeRecord({ version: 1, owned: next.owned });
      else await removeFile(receipt, receiptRules);
    }
    return result;
  };
  return dryRun ? edit() : withConfigurationLock({ home }, edit);
}
