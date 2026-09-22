import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@stroq/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'site/test/**/*.test.ts'],
    setupFiles: ['./test/setup-env.ts'],
    /**
     * Vitest's default is 5 s, and a large part of this suite is not unit tests: the
     * hook, proxy and command files spawn a real CLI through `node --import tsx`,
     * which compiles TypeScript on every start. On a busy machine two of those in one
     * test go past 5 s and the test fails with `Test timed out in 5000ms` — a report
     * about the machine, not about the code, and one that arrives in a different file
     * each run, which is what a flaky suite looks like from the outside.
     *
     * 30 s costs nothing when tests pass, because a passing test never reaches it.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/index.ts', 'packages/cli/src/index.ts'],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
    },
  },
});
