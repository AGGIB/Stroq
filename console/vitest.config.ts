import { defineConfig } from 'vitest/config';

// Its own config, so vitest does not climb to the CLI repository's config above.
export default defineConfig({
  test: { include: ['lib/**/*.test.ts'], environment: 'node' },
});
