import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rootIdentity, snapshotFile } from '../console/scripts/agent-setup-files.mjs';
import {
  runtimeAdapterNames,
  runtimeServiceNames,
  writeRuntimeManifest,
} from '../console/scripts/build-runtime-manifest.mjs';

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function copyFile(root, source, destination, budget) {
  const file = await snapshotFile(root, join(root.path, source), 16 * 1024 * 1024);
  if (
    file.bytes === null ||
    ++budget.files > 2048 ||
    (budget.bytes += file.bytes.length) > 64 * 1024 * 1024
  )
    throw new Error('platform-package-limit');
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, file.bytes, { mode: 0o644 });
}

async function copyStatic(root, source, destination, budget, depth = 0) {
  if (depth > 12) throw new Error('platform-package-depth');
  const directory = await rootIdentity(join(root.path, source));
  for (const entry of await readdir(directory.path, { withFileTypes: true })) {
    if (++budget.entries > 2048) throw new Error('platform-package-limit');
    if (entry.name.startsWith('.') || entry.isSymbolicLink())
      throw new Error('unsafe-platform-asset');
    const child = `${source}/${entry.name}`;
    if (entry.isDirectory())
      await copyStatic(root, child, join(destination, entry.name), budget, depth + 1);
    else if (entry.isFile()) await copyFile(root, child, join(destination, entry.name), budget);
    else throw new Error('unsafe-platform-asset');
  }
}

/** Stage a complete static platform after the CLI's clean build. Nothing is published. */
export async function packagePlatform(repository = REPOSITORY) {
  const root = await rootIdentity(repository);
  const cli = join(root.path, 'packages/cli');
  const stageName = `.platform-stage-${randomUUID()}`;
  const staging = join(cli, stageName);
  const stage = join(staging, 'platform');
  const budget = { entries: 0, files: 0, bytes: 0 };
  await mkdir(stage, { recursive: true });
  try {
    // Refuse a partial export before replacing any previous packaged build.
    const index = await snapshotFile(root, join(root.path, 'console/out/index.html'));
    if (index.bytes === null) throw new Error('platform-export-missing');
    const scripts = await rootIdentity(join(root.path, 'console/scripts'));
    for (const name of await runtimeServiceNames(scripts))
      await copyFile(root, `console/scripts/${name}`, join(stage, 'scripts', name), budget);
    const adapters = await rootIdentity(join(root.path, 'console/.local-engine'));
    for (const name of await runtimeAdapterNames(adapters))
      await copyFile(
        root,
        `console/.local-engine/${name}`,
        join(stage, '.local-engine', name),
        budget,
      );
    await copyFile(root, 'packages/core/dist/index.js', join(stage, 'core/index.js'), budget);
    await copyStatic(root, 'console/out', join(stage, 'out'), budget);
    const files = await writeRuntimeManifest({
      root: staging,
      platform: 'platform',
      core: 'platform/core/index.js',
      manifest: join(stage, 'runtime-manifest.json'),
    });
    await rm(join(cli, 'platform'), { recursive: true, force: true });
    await rename(stage, join(cli, 'platform'));
    return { files: budget.files, bytes: budget.bytes, runtimeFiles: files.length };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await packagePlatform();
  console.log(
    `Packaged local platform: ${result.files} files, ${result.runtimeFiles} runtime files.`,
  );
}
