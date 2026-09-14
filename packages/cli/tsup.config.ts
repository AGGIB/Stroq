import { copyFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  // No sourcemap in the published tarball: nothing consumes it (this is a CLI, not a
  // library other bundlers resolve stack traces through), and it roughly doubled the
  // unpacked package size for no benefit.
  sourcemap: false,
  noExternal: ['@stroq/core'],
  banner: { js: '#!/usr/bin/env node' },
  onSuccess: async () => {
    // scenarios/index.ts reads this next to dist/index.js at runtime (see its
    // top-of-file comment for why the attack corpus ships as JSON, not bundled JS).
    copyFileSync('src/attack/scenarios/corpus.json', 'dist/corpus.json');
    // coverage/atlas.ts reads this next to dist/index.js at runtime, for the same
    // reason corpus.json is not bundled: it is data, and data belongs beside the
    // bundle where a reader can diff it against the vendored source.
    copyFileSync('src/coverage/atlas.json', 'dist/atlas.json');
  },
});
