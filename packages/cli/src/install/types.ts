// The vocabulary of Safe Install (`stroq vet`, `add`, `remove`): what a fetched skill or MCP server is
// held as while it is looked at, what is said of it, and the limits it is held to. The design of
// record is docs/superpowers/specs/2026-10-10-safe-install.md.
//
// Everything here is read-only. A tree is made once, in memory, by a reader that has checked it; what
// is digested, analysed, shown and written is that one tree. A passport is a record that is put in a
// lock file and read back later, so its schema is strict: a key it does not know is an error, not
// something to ignore.
import { z } from 'zod';

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

/**
 * What a source may cost before it is refused. The size limits are held by whatever reads the bytes
 * (a directory reader, a tar reader), the path limits by `checkEntryPath`, and the clock limits by the
 * one module that touches the network. A tree that is over any of them is not looked at further: a
 * source that needs more is not a skill or a server, or is an attack on the person who looks.
 */
export const LIMITS = Object.freeze({
  /** The most a download may be, as sent: 20 MiB. */
  maxCompressed: 20 * 1024 * 1024,
  /** The most all the files may be together, once unpacked: 32 MiB. A compressed bomb is stopped here. */
  maxExpanded: 32 * 1024 * 1024,
  /** The most entries (files, links, nested repositories) a tree may have. */
  maxEntries: 5000,
  /** The longest path, in UTF-8 bytes. The common filesystems stop at 255 for a name and more for a path. */
  maxPathBytes: 240,
  /** The most components a path may have. */
  maxDepth: 20,
  /** The largest single file: 8 MiB. A bigger one is not read, and so is not vouched for. */
  maxFileBytes: 8 * 1024 * 1024,
  /** The longest one request may take, in milliseconds. */
  perRequestMs: 20_000,
  /** The longest all the requests of one fetch may take together, in milliseconds. */
  totalMs: 60_000,
} as const);

// ---------------------------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------------------------

/** `symlink` is recorded and never made on a disk; `gitlink` is a nested repository, recorded and never opened. */
export type EntryKind = 'file' | 'symlink' | 'gitlink';

/**
 * One thing in a tree. `sha256` is of the raw bytes of a file, and of the UTF-8 bytes of the target
 * text of a symlink; a gitlink has none and records 64 zeros. `size` is the number of those bytes.
 *
 * `bytes` is there while a tree is being looked at and may be left out of a tree that is only
 * compared (one read back from a manifest); then `size` and `sha256` stand for the bytes, and are
 * all the digest uses. `target` is the text a symlink points at.
 */
export interface TreeEntry {
  /** Relative to the root of the artifact, with `/` between components. See `checkEntryPath`. */
  readonly path: string;
  readonly kind: EntryKind;
  /** The owner-execute bit. Only a file has it; it is part of the digest, because it is what makes a script a program. */
  readonly exec: boolean;
  readonly size: number;
  readonly sha256: string;
  readonly bytes?: Uint8Array;
  readonly target?: string;
}

/** A skill or an MCP server as the files it is made of. Empty directories are not entries. */
export interface Tree {
  readonly entries: readonly TreeEntry[];
}

// ---------------------------------------------------------------------------------------------
// The passport
// ---------------------------------------------------------------------------------------------

/**
 * What a line of a passport rests on, in the words it is shown with.
 *
 * - `declared`: the artifact says so about itself (its front matter, its manifest).
 * - `observed`: reading its files found it. This is a reading and not a run, and says nothing of
 *   what was not read.
 * - `limited`: Stroq itself holds the artifact to it when it runs it (the environment names a wrapper
 *   passes on, say). The only basis a negative claim such as "no credentials granted" may rest on.
 * - `unknown`: there is something here that could not be understood (a URL built at run time, a shell
 *   line that does not parse).
 */
export const BASES = ['declared', 'observed', 'limited', 'unknown'] as const;
export type Basis = (typeof BASES)[number];

/**
 * What a line is about, and so what its `subject` is:
 * `fs.read` and `fs.write` a path; `net` a host; `cred.env` an environment variable; `cred.file` a
 * credential file; `exec` a command; `hook` a hook command; `install-script` a lifecycle script of a
 * package; `tool` a tool an MCP server offers; `allowed-tools` a tool a skill asks to be allowed;
 * `signal` a rule that matched, which is a signal to look and not a verdict.
 */
export const CAP_KINDS = [
  'fs.read',
  'fs.write',
  'net',
  'cred.env',
  'cred.file',
  'exec',
  'hook',
  'install-script',
  'tool',
  'allowed-tools',
  'signal',
] as const;
export type CapKind = (typeof CAP_KINDS)[number];

export const ARTIFACT_KINDS = ['skill', 'mcp', 'plugin'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** The name of the format of a passport, which a reader of an old one checks before anything else. */
export const PASSPORT_SCHEMA = 'stroq-passport/1' as const;

const nonEmpty = z.string().min(1);

/**
 * A label for something on this machine says which skill it was, not where it lives. A passport is
 * canonical, so that an author can commit one and a reader can compare it: a path from the root of
 * a disk would differ from machine to machine and would carry a user name.
 */
const ABSOLUTE_PATH = /^(?:[\\/]|[A-Za-z]:)/;
const label = nonEmpty.refine((text) => !ABSOLUTE_PATH.test(text), {
  message: 'a label is never an absolute path',
});

/** Where an artifact came from, as much as is needed to fetch it again and to tell it from another. */
export const SourceRefSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('dir'), label }).readonly(),
  z.strictObject({ type: z.literal('tarball'), label }).readonly(),
  z
    .strictObject({
      type: z.literal('npm'),
      name: nonEmpty,
      version: nonEmpty,
      integrity: z.exactOptional(nonEmpty),
    })
    .readonly(),
  z
    .strictObject({
      type: z.literal('github'),
      owner: nonEmpty,
      repo: nonEmpty,
      ref: nonEmpty,
      commit: z.exactOptional(nonEmpty),
      subdir: z.exactOptional(nonEmpty),
    })
    .readonly(),
  // The host only: the address is the host the bytes came from, and a path or a token has no place in a record.
  z.strictObject({ type: z.literal('url'), host: nonEmpty }).readonly(),
]);
export type SourceRef = z.infer<typeof SourceRefSchema>;

/** What another tool said about the artifact. Shown as that tool's claim, never as ours; it does not change the digest. */
export const ImportedFindingSchema = z
  .strictObject({
    tool: nonEmpty,
    id: nonEmpty,
    severity: nonEmpty,
    title: z.string(),
    path: z.exactOptional(nonEmpty),
    line: z.exactOptional(z.number().int().positive()),
  })
  .readonly();
export type ImportedFinding = z.infer<typeof ImportedFindingSchema>;

/**
 * One thing the artifact can do or asks for. `sensitive` marks the lines whose arrival makes an update
 * a material change. `where` is the places in the files that it was read from, and `detector` the
 * reading that found it, so that a person can check the claim against the file.
 */
export const PassportLineSchema = z
  .strictObject({
    kind: z.enum(CAP_KINDS),
    subject: nonEmpty,
    basis: z.enum(BASES),
    sensitive: z.boolean(),
    where: z
      .array(
        z
          .strictObject({
            file: nonEmpty,
            line: z.number().int().positive().nullable(),
          })
          .readonly(),
      )
      .readonly(),
    detector: nonEmpty,
  })
  .readonly();
export type PassportLine = z.infer<typeof PassportLineSchema>;

const count = z.number().int().nonnegative();

/**
 * What `stroq vet` says about an artifact, and what a lock file keeps of what was confirmed. It holds
 * no time and no path of this machine, so that the same artifact gives the same passport anywhere.
 *
 * An absent line means nothing was seen, and `blindSpots` is what was not looked at: a passport is a
 * list of what was found, never a promise of what is not there.
 */
export const PassportSchema = z
  .strictObject({
    schema: z.literal(PASSPORT_SCHEMA),
    artifact: z
      .strictObject({
        kind: z.enum(ARTIFACT_KINDS),
        name: nonEmpty,
        version: nonEmpty.nullable(),
        source: SourceRefSchema,
        /** The tree digest: 64 lower-case hex characters. */
        digest: z.string().regex(/^[0-9a-f]{64}$/),
        files: count,
        bytes: count,
      })
      .readonly(),
    lines: z.array(PassportLineSchema).readonly(),
    blindSpots: z.array(nonEmpty).readonly(),
    signals: z.array(z.strictObject({ ruleId: nonEmpty, file: nonEmpty }).readonly()).readonly(),
    imported: z.array(ImportedFindingSchema).readonly(),
    /** Which Stroq and which rules made the reading, so that a changed answer can be put down to a changed reader. */
    analysis: z.strictObject({ stroq: nonEmpty, rules: nonEmpty }).readonly(),
  })
  .readonly();
export type Passport = z.infer<typeof PassportSchema>;
