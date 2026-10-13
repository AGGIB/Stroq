import type { NamedReading } from '../install/inspect/index.js';
import type { ArtifactKind } from '../install/types.js';

/** The command line of `stroq vet`, read and checked. */
export interface VetOptions {
  /** The folder or archive file to read. The user's own path: it is read, and never put in the passport. */
  readonly from: string;
  /** What the artifact is, or `auto` to tell from its files. */
  readonly kind: ArtifactKind | 'auto';
  readonly json: boolean;
  readonly card: boolean;
  /** The digest the files are expected to have: 64 lower-case hexadecimal digits, without a prefix. */
  readonly expect: string | null;
  /** A file to write the output to. It must not exist yet. */
  readonly out: string | null;
}

/**
 * What a test may replace. The streams, so that the output can be read; the platform, so that Windows can be
 * simulated (a folder has no executable bit there, and `--expect` is refused for one); the version of Stroq, so that a
 * passport does not change with each release; and the readings, so that one of them can be made to fail.
 */
export interface VetDeps {
  readonly out?: (text: string) => void;
  readonly err?: (text: string) => void;
  readonly platform?: NodeJS.Platform;
  readonly stroqVersion?: string;
  readonly readings?: readonly NamedReading[];
}
