import { copyFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig, type Options } from 'tsup';
import { runtimeBundle } from '../core/src/rules/runtime-rule.js';

type Plugin = NonNullable<Options['esbuildPlugins']>[number];

/**
 * The rule bundle as the engine reads it (`core/src/rules/runtime-rule.ts`): about a quarter of the
 * file the corpus is vendored in. Every hook call parsed and built the rest, and read none of it.
 */
const runtimeRules: Plugin = {
  name: 'stroq-runtime-rules',
  setup(build) {
    build.onLoad({ filter: /[\\/]core[\\/]src[\\/]rules\.bundle\.json$/ }, (args) => ({
      contents: JSON.stringify(runtimeBundle(JSON.parse(readFileSync(args.path, 'utf8')))),
      loader: 'json',
    }));
  },
};

/**
 * zod's licence file. zod is part of `dist` (see `noExternal`), and its licence asks that the notice
 * travel with copies of the code.
 */
const zodLicense = join(
  dirname(createRequire(import.meta.url).resolve('zod/package.json')),
  'LICENSE',
);

export default defineConfig({
  // `dist/index.js` is what every hook line, the plugin wrapper and `bin` start. It is built from
  // `bin.ts`, which turns on the compile cache and then loads `index.ts` (see `bin.ts` for why).
  entry: { index: 'src/bin.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  // No sourcemap in the published tarball: nothing consumes it (this is a CLI, not a
  // library other bundlers resolve stack traces through), and it roughly doubled the
  // unpacked package size for no benefit.
  sourcemap: false,
  // zod is bundled too. Its package entry loads one module for each of its 70 locales and the hook
  // uses one, so a PreToolUse read about a hundred files of zod before it began; bundled, the
  // locales that are not used are dropped. `yaml` is not on the hook's path and stays a dependency.
  noExternal: ['@stroq/core', 'zod'],
  esbuildPlugins: [runtimeRules],
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
    // The notice zod's licence asks to accompany the code that is now in dist/ (see `zodLicense`).
    copyFileSync(zodLicense, 'dist/LICENSE.zod');
  },
});
