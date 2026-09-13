import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stroqVersion } from '../src/version.js';

describe('stroqVersion', () => {
  it('returns the version from the package manifest', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(stroqVersion()).toBe(manifest.version);
  });

  it('returns a semver-shaped string', () => {
    expect(stroqVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
