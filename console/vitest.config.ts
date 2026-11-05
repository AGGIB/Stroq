import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

// Its own config, so vitest does not climb to the CLI repository's config above.
// The `@/` alias mirrors tsconfig so a test can load a component with its real imports.
export default defineConfig({
  resolve: { alias: [{ find: /^@\//, replacement: root }] },
  test: { include: ['lib/**/*.test.ts'], environment: 'node' },
});
