import { randomUUID } from 'node:crypto';
import { redact } from '../audit/audit-log.js';
import type { SecretIndex } from '../secrets/index.js';
import type { Atom, PostToolEvent, PreToolEvent, ProvenanceGap } from '../types.js';
import { atomHash } from './atoms.js';
import { candidatesOfVariants, excerptRedactor } from './excerpt.js';
import type { ProvenanceInput, ProvenanceStore } from './store.js';

/** The longest an excerpt or a source is kept, as stored and as audited. */
export const MAX_STORED_CHARS = 120;

/** The most atoms the audit names as unverifiable: enough to say what, not a copy of the command. */
const MAX_GAPS_AUDITED = 3;

/** What recording one result's provenance came to: the failure, and whether evidence was lost. */
export interface ProvenanceOutcome {
  readonly error: string | null;
  readonly incomplete: boolean;
}

/** Atoms credited to one reading, whose text is the source for secret redaction. */
export interface ProvenanceReading {
  readonly text: string;
  readonly atoms: readonly Atom[];
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

  /** Notes the loss of hashes, never throwing; the error message, or null. Falls back to the wider note. */
  private async noteDigests(store: ProvenanceStore, sessionId: string): Promise<string | null> {
    try {
      await store.noteDigestsLost(sessionId);
      return null;
    } catch (err) {
      const wider = await this.note(store, sessionId);
      return wider === null ? null : messageOf(err);
    }
  }

  /**
   * Marks that a scanned result is about to be recorded, before it is scanned. The scan, the taint
   * and the records come one after the other, with a secret-index lookup and a lock between; a
   * process that stops anywhere in that stretch (a scan that does not finish, the hook's deadline,
   * a crash) would leave a session that read the result and has no trace of it, and a flagged one
   * that is not tainted. The marker stays and the session reads as incomplete. Never throws:
   * failure to write the marker must not prevent the scan or the attempt to write records.
   */
  async begin(sessionId: string): Promise<string | undefined> {
    if (!this.store) return undefined;
    const owner = randomUUID();
    await this.store.setPending(sessionId, true, owner).catch(() => undefined);
    return owner;
  }

  /**
   * Takes off the marker of an operation that was given up on: its result was never delivered, so
   * nothing the session did not see is unrecorded. Never throws.
   */
  async release(sessionId: string, owner: string): Promise<void> {
    if (this.store) await this.settle(this.store, sessionId, owner);
  }

  /** Takes off only this operation's marker, once its records or loss note are durable. */
  private async settle(
    store: ProvenanceStore,
    sessionId: string,
    owner: string | undefined,
  ): Promise<void> {
    if (owner !== undefined) await store.setPending(sessionId, false, owner).catch(() => undefined);
  }

  /**
   * Persists provenance for the atoms of all readings, settling their shared owner once.
   *
   * Recording is also evidence, and what is not recorded reads, to a later lookup, as
   * not read. So `lost` (the extraction left atoms out) and a failed write both mark the
   * session incomplete, and only `stroq untaint` takes the mark off.
   */
  async record(
    event: PostToolEvent,
    summary: string,
    readings: readonly ProvenanceReading[],
    suspect: boolean,
    lost: boolean,
    pendingOwner?: string,
    digestsLost = false,
    flaggedOwn = false,
  ): Promise<ProvenanceOutcome> {
    const store = this.store;
    if (!store) return { error: null, incomplete: false };
    // Hashes left out are a narrow loss, noted apart: it makes an unrecorded blob a question and
    // leaves the floor of packages and pipe-to-shell commands alone. A note that cannot be written
    // is the wider loss, since nothing else would say that hashes went.
    const digestNote = digestsLost ? await this.noteDigests(store, event.sessionId) : null;
    const noted = lost ? await this.note(store, event.sessionId) : null;
    // Report whether the permanent loss note was written. If it failed, an operation marker
    // can still keep the session reading as incomplete, and the failure is logged.
    const marked = lost && noted === null;
    // The operation's marker comes off only when every loss is durably noted, the narrow one too.
    // A note that could not be written leaves the marker as the evidence: it goes stale, and the
    // session then asks about what nothing accounts for.
    const digestsNoted = !digestsLost || digestNote === null;
    const settles = (!lost || marked) && digestsNoted;
    if (readings.every((reading) => reading.atoms.length === 0)) {
      if (settles) await this.settle(store, event.sessionId, pendingOwner);
      return { error: noted ?? digestNote, incomplete: marked };
    }
    const source = redact(summary).slice(0, MAX_STORED_CHARS);
    // The secret index must read the text each atom came from, including extra readings:
    // a value echoed in just one of them cannot be checked against the primary alone.
    const inputs: ProvenanceInput[] = [];
    for (const reading of readings) {
      const excerpts = await this.excerpts(reading.text, event.cwd, reading.atoms);
      reading.atoms.forEach((atom, i) =>
        inputs.push({
          tool: event.toolName,
          source,
          kind: atom.kind,
          hash: atomHash(atom),
          excerpt: excerpts[i] ?? '',
          suspect,
          ...(flaggedOwn && !suspect ? { flaggedOwn: true } : {}),
        }),
      );
    }
    try {
      await store.record(event.sessionId, inputs);
      if (settles) await this.settle(store, event.sessionId, pendingOwner);
      return { error: noted ?? digestNote, incomplete: marked };
    } catch (err) {
      const failed = await this.note(store, event.sessionId);
      // If the permanent note failed too, the operation's marker is the evidence that remains.
      if (failed === null && digestsNoted) await this.settle(store, event.sessionId, pendingOwner);
      return { error: messageOf(err), incomplete: failed === null };
    }
  }
}
