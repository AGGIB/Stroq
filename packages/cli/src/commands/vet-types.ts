import type { Transport } from '../install/fetch.js';
import type { NamedReading } from '../install/inspect/index.js';
import type { ProbeLauncher } from '../install/mcp-probe.js';
import type { ArtifactKind } from '../install/types.js';
import type { Terminal } from '../ui/terminal.js';

interface VetCommonOptions {
  /** What the artifact is, or `auto` to tell from its files. */
  readonly kind: ArtifactKind | 'auto';
  readonly json: boolean;
  readonly card: boolean;
  /** The digest the files are expected to have: 64 lower-case hexadecimal digits, without a prefix. */
  readonly expect: string | null;
  /** A file to write the output to. It must not exist yet. */
  readonly out: string | null;
  /** Opt-in sandboxed probe for vetted MCP servers. */
  readonly probe: boolean;
  /** Entrypoint override for the server. */
  readonly entrypoint?: string | undefined;
}

/** The command line of `stroq vet`, read and checked: either local with --from or online with --online. */
export type VetOptions =
  | (VetCommonOptions & {
      /** The folder or archive file to read. */
      readonly from: string;
      readonly online: null;
    })
  | (VetCommonOptions & {
      readonly from: null;
      /** The online package or address to read. */
      readonly online: string;
    });

/**
 * What a test may replace. The streams, so that the output can be read; the platform, so that Windows can be
 * simulated (a folder has no executable bit there, and `--expect` is refused for one); the version of Stroq, so that a
 * passport does not change with each release; the readings, so that one of them can be made to fail; and the network transport.
 */
export interface VetDeps {
  readonly out?: (text: string) => void;
  readonly err?: (text: string) => void;
  readonly platform?: NodeJS.Platform;
  readonly stroqVersion?: string;
  readonly readings?: readonly NamedReading[];
  readonly transport?: Transport;
  readonly terminal?: Terminal | undefined;
  readonly confirm?: (() => Promise<boolean> | boolean) | undefined;
  readonly launcher?: ProbeLauncher | undefined;
  readonly srtBin?: string | null | undefined;
}
