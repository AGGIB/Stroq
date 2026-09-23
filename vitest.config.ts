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
    globalSetup: ['./test/global-setup.ts'],
    /**
     * Vitest's default is 5 s, and a large part of this suite is not unit tests: the
     * hook, proxy and command files spawn the real, built CLI. On a busy machine two
     * of those in one test can go past 5 s and the test fails with `Test timed out in
     * 5000ms` — a report about the machine, not about the code, and one that arrives
     * in a different file each run, which is what a flaky suite looks like from the
     * outside.
     *
     * 30 s costs nothing when tests pass, because a passing test never reaches it.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/index.ts', 'packages/cli/src/index.ts'],
      // Just under what the suite measures (lines 96.5, statements 94.7, functions
      // 98.4, branches 87.3 on 2026-09-24). At 80/70 the floor sat seventeen points
      // below reality, so coverage could fall that far without CI saying anything.
      thresholds: { lines: 96, functions: 97, statements: 94, branches: 86 },
    },
  },
});
