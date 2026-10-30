import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import { readRegularFile, type RegularFileRead } from '@stroq/core';

/** The detector reads through this seam; its decisions remain shared with the CLI. */
export interface SurfaceReadContext {
  exists(path: string): boolean;
  stat(path: string): Stats;
  lstat(path: string): Stats;
  entries(path: string): Dirent[];
  realpath(path: string): string;
  readlink(path: string): string;
  read(path: string, maxBytes: number): RegularFileRead;
  label?(path: string): string;
  parseGap?(path: string): void;
  /** Record a presence-only surface such as .envrc with its exact source bytes. */
  capturePresence?(path: string, maxBytes: number): void;
  skipDirectory?(path: string): boolean;
  /** Record a `.git` below the root of a repository, whose configuration and hooks are not read. */
  nestedRepository?(path: string): void;
  /** Internal captures need repeatable comparisons; legacy CLI output remains run-keyed. */
  stableDigest?(text: string): string;
  gitMetadata?: {
    isRepo: boolean;
    configs: readonly string[];
    hooks: string | null;
    attributes: readonly string[];
  };
}

/** Legacy callers retain their original read and fallback behavior. */
export const LEGACY_SURFACE_IO: SurfaceReadContext = {
  exists: existsSync,
  stat: statSync,
  lstat: lstatSync,
  entries: (path) => readdirSync(path, { withFileTypes: true }),
  realpath: realpathSync,
  readlink: readlinkSync,
  read: readRegularFile,
};
