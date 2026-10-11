import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertStaysInside } from '../../src/commands/config-file.js';
import { backupsDirIn, hardenDirIn, hardenManifestFileIn } from '../../src/paths.js';

describe('the harden layout inside a Stroq home', () => {
  it('keeps the manifest in its own directory, so the lock beside it has a place to live', () => {
    expect(hardenDirIn('/h')).toBe(join('/h', 'harden'));
    expect(hardenManifestFileIn('/h')).toBe(join('/h', 'harden', 'manifest.json'));
  });

  it('keeps byte copies in a directory of their own, so that deleting them is one command', () => {
    expect(backupsDirIn('/h')).toBe(join('/h', 'backups'));
  });
});

describe('assertStaysInside', () => {
  // The engine's atomic writer applies the same rule `init` does, so the rule has to be reachable.
  it('is exported from the config module', () => {
    expect(typeof assertStaysInside).toBe('function');
  });
});
