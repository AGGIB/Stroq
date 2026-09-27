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
  // tsup strips `node:` from builtin imports by default. `fs` still resolves without
  // it; `sqlite` does not exist at all, so the Cursor reader loaded nothing in the
  // published CLI and blamed the user's Node version for it.
  removeNodeProtocol: false,
  banner: { js: '#!/usr/bin/env node' },
  onSuccess: async () => {
    // scenarios/index.ts reads this next to dist/index.js at runtime (see its
    // top-of-file comment for why the attack corpus ships as JSON, not bundled JS).
    copyFileSync('src/attack/scenarios/corpus.json', 'dist/corpus.json');
    // coverage/atlas.ts reads this next to dist/index.js at runtime, for the same
    // reason corpus.json is not bundled: it is data, and data belongs beside the
    // bundle where a reader can diff it against the vendored source.
    copyFileSync('src/coverage/atlas.json', 'dist/atlas.json');
    // coverage/scope.ts reads this next to dist/index.js at runtime, for the same
    // reason: it is a hand-authored judgement call, and a reader should be able to
    // diff it directly rather than decompile it out of the bundle.
    copyFileSync('src/coverage/scope.json', 'dist/scope.json');
    // coverage/asi.ts reads this next to dist/index.js at runtime, for the same
    // reason: OWASP publishes no machine-readable release, so this is a
    // hand-transcribed, version-pinned file a reader should be able to diff directly.
    copyFileSync('src/coverage/asi.json', 'dist/asi.json');
  },
});
