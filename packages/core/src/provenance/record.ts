import { redact } from '../audit/audit-log.js';
import type { SecretIndex } from '../secrets/index.js';
import type { Atom, PostToolEvent, PreToolEvent, ProvenanceGap } from '../types.js';
import { atomHash } from './atoms.js';
import { candidatesOfVariants, excerptRedactor } from './excerpt.js';
import type { ProvenanceStore } from './store.js';

/** The longest an excerpt or a source is kept, as stored and as audited. */
export const MAX_STORED_CHARS = 120;

/** The most atoms the audit names as unverifiable: enough to say what, not a copy of the command. */
const MAX_GAPS_AUDITED = 3;

/** What recording one result's provenance came to: the failure, and whether evidence was lost. */
export interface ProvenanceOutcome {
  readonly error: string | null;
  readonly incomplete: boolean;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Writing what a tool result carried into the provenance store, and saying what could not be
 * written. It never throws: recording is enrichment, so a store failure (corrupt state, ENOSPC,
 * lock timeout) must not cost the caller the scan verdict and taint already computed.
 */
export class ProvenanceRecorder {
  constructor(
    private readonly store: ProvenanceStore | undefined,
    private readonly secrets: SecretIndex | undefined,
  ) {}

  /**
   * The text each atom is stored under, `atoms[i]` at `[i]`: structurally redacted, clipped,
   * and with every value the secret index knows taken out (see `excerptRedactor` for the
   * spellings an atom can hold one in). The values are looked up in every form the atoms
   * were read from. A failing index withholds the excerpt rather than storing it unchecked,
   * and so does a result that holds too many known values to check.
   */
  async excerpts(text: string, cwd: string, atoms: readonly Atom[]): Promise<string[]> {
    const clip = (value: string): string => redact(value).slice(0, MAX_STORED_CHARS);
    const index = this.secrets;
    if (!index) return atoms.map((atom) => clip(atom.value));
    try {
      const matches = await index.lookup(candidatesOfVariants(text), cwd);
      if (matches.length === 0) return atoms.map((atom) => clip(atom.value));
      const scrub = excerptRedactor(text, matches);
      if (scrub === null) return atoms.map(() => '[REDACTED:too-many-secrets]');
      return atoms.map((atom) => clip(scrub(atom)));
    } catch {
      return atoms.map(() => '[REDACTED:secret-index-unavailable]');
    }
  }

  /**
   * The atoms no record accounts for, as the audit keeps them: kind and an excerpt scrubbed
   * as a provenance record's is. An atom is cut from normalised text, so a known value sits in
   * it lowercased and a plain redaction of the call's summary would miss it.
   */
  async gaps(unverified: readonly Atom[], event: PreToolEvent): Promise<ProvenanceGap[]> {
    const shown = unverified.slice(0, MAX_GAPS_AUDITED);
    if (shown.length === 0) return [];
    const command = event.toolInput['command'];
    const text = typeof command === 'string' ? command : JSON.stringify(event.toolInput);
    const excerpts = await this.excerpts(text, event.cwd, shown);
    return shown.map((atom, i) => ({ kind: atom.kind, excerpt: excerpts[i] ?? '' }));
  }

  /**
   * Notes that evidence for the session was lost, never throwing; the error message, or null.
   * Called before the records of the same result are written, so the note is never later than
   * the loss it describes.
   */
  private async note(store: ProvenanceStore, sessionId: string): Promise<string | null> {
    try {
      await store.markIncomplete(sessionId);
      return null;
    } catch (err) {
      return messageOf(err);
    }
  }

  /**
   * Marks that a result which taints the session is about to be recorded. The taint is written
   * first and the records after, with a secret-index lookup and a lock between; a process that
   * goes in that gap would leave a session that is flagged and has no trace. Never throws: where
   * the marker cannot be written the sessions directory is unwritable, which already reads as
   * incomplete.
   */
  async begin(sessionId: string): Promise<void> {
    await this.store?.setPending(sessionId, true).catch(() => undefined);
  }

  /** Takes the marker `begin` put on off again, whether or not the records were written. */
  private async settle(store: ProvenanceStore, sessionId: string): Promise<void> {
    await store.setPending(sessionId, false).catch(() => undefined);
  }

  /**
   * Persists provenance for `atoms`.
   *
   * Recording is also evidence, and what is not recorded reads, to a later lookup, as
   * not read. So `lost` (the extraction left atoms out) and a failed write both mark the
   * session incomplete, and only `stroq untaint` takes the mark off.
   */
  async record(
    event: PostToolEvent,
    summary: string,
    atoms: readonly Atom[],
    suspect: boolean,
    lost: boolean,
  ): Promise<ProvenanceOutcome> {
    const store = this.store;
    if (!store) return { error: null, incomplete: false };
    const noted = lost ? await this.note(store, event.sessionId) : null;
    // Only a note that was written makes the session incomplete: one that could not be leaves
    // it reading as it did, and the failure is the error that gets logged.
    const marked = lost && noted === null;
    if (atoms.length === 0) {
      await this.settle(store, event.sessionId);
      return { error: noted, incomplete: marked };
    }
    const source = redact(summary).slice(0, MAX_STORED_CHARS);
    const excerpts = await this.excerpts(event.toolResultText, event.cwd, atoms);
    try {
      await store.record(
        event.sessionId,
        atoms.map((atom, i) => ({
          tool: event.toolName,
          source,
          kind: atom.kind,
          hash: atomHash(atom),
          excerpt: excerpts[i] ?? '',
          suspect,
        })),
      );
      await this.settle(store, event.sessionId);
      return { error: noted, incomplete: marked };
    } catch (err) {
      const failed = await this.note(store, event.sessionId);
      await this.settle(store, event.sessionId);
      return { error: messageOf(err), incomplete: failed === null };
    }
  }
}
