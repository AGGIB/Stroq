import { fileURLToPath } from 'node:url';

/**
 * The CLI as users run it: the bundle `pnpm build` writes, with `@stroq/core` inside.
 *
 * The end-to-end tests used to spawn `node --import tsx src/index.ts`, which tested
 * the source rather than the artifact — a function `core` forgot to export passed
 * every test while the built CLI failed at startup — and compiled TypeScript on every
 * spawn, which is most of why the suite timed out on a loaded machine. `globalSetup`
 * builds once before any test runs, so this file is never stale.
 */
export const CLI_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
