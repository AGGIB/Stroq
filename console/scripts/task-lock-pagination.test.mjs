import { after } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

// Register the actual-source regression cases in the ordinary scripts/*.test.mjs suite.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await mkdtemp(join(tmpdir(), 'stroq-task-page-test-loader-'));
after(() => rm(temporary, { recursive: true, force: true }));
const tsconfig = join(temporary, 'tsconfig.json');
await writeFile(
  tsconfig,
  JSON.stringify({
    compilerOptions: {
      baseUrl: repository,
      paths: { '@stroq/core': ['packages/core/src/index.ts'] },
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      esModuleInterop: true,
      resolveJsonModule: true,
    },
  }),
);
await tsImport('./task-lock-pagination.test.ts', { parentURL: import.meta.url, tsconfig });
