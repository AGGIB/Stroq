import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { createCredentialFilterService } from './credential-filters.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export async function bundle() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-filter-adapters-')));
  await build({
    entry: {
      worker: join(root, 'scripts/credential-filter-worker.ts'),
      engine: join(root, 'scripts/credential-filter-engine.ts'),
      schema: join(root, 'lib/credential-filters.ts'),
      inspect: join(root, 'scripts/credential-filter-inspect.ts'),
    },
    outDir: dir,
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    splitting: false,
    dts: false,
    config: false,
    silent: true,
    noExternal: ['@stroq/core', 'yaml', 'zod'],
    banner: {
      js: "import { createRequire as createEngineRequire } from 'node:module'; const require = createEngineRequire(import.meta.url);",
    },
    esbuildOptions(options) {
      options.alias = { '@stroq/core': resolve(root, '../packages/core/src/index.ts') };
    },
  });
  return {
    dir,
    api: await import(pathToFileURL(join(dir, 'inspect.js')).href),
    clean: () => rm(dir, { recursive: true, force: true }),
  };
}
export async function fixture(t, adapters, options = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-filter-backend-')));
  const project = join(dir, 'workspace'),
    userHome = join(dir, 'profile'),
    home = join(userHome, '.stroq');
  await mkdir(project, { mode: 0o700 });
  await mkdir(userHome, { mode: 0o700 });
  const packageFile = join(dir, 'package.json');
  await writeFile(packageFile, '{"version":"0.29.0"}');
  const services = [];
  const service = (extra = {}) => {
    const value = createCredentialFilterService({
      project,
      userHome,
      home,
      platform: 'darwin',
      claudeConfigDir: '',
      paths: { package: packageFile },
      workerPath: join(adapters.dir, 'worker.js'),
      enginePath: join(adapters.dir, 'engine.js'),
      schemaPath: join(adapters.dir, 'schema.js'),
      runtimeDigest: async () => 'a'.repeat(64),
      ...options,
      ...extra,
    });
    services.push(value);
    return value;
  };
  const filters = service();
  t.after(async () => {
    for (const value of services) await value.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, project, userHome, home, filters, service };
}
export async function put(file, bytes, mode = 0o600) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, bytes, { mode });
  return file;
}
export function request(body, extra = {}) {
  return {
    previewId: body.id,
    confirm: true,
    acknowledgeNativeLimits: true,
    acknowledgePrivateRetention: true,
    ...(body.action === 'undo-filter' ? { acknowledgeWeakenFilter: true } : {}),
    ...Object.fromEntries(
      Object.entries(body.needs)
        .filter(([, v]) => v)
        .map(([key]) => [key, true]),
    ),
    ...extra,
  };
}
export const apply = (service, body, extra = {}) => service.apply(request(body, extra));
export const preview = (service, target = 'cursor-project', action = 'apply-filter') =>
  service.preview({ target, action });

/** Canonical JSON with sorted keys, as `stableStringify` in packages/core. */
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map((v) => canonical(v === undefined ? null : v)).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value)
          .filter((k) => value[k] !== undefined)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
          .join(',')}}`
      : JSON.stringify(value);

/** A harden manifest with these files, signed with the home's state key the way `stroq harden` signs it. */
export async function signedManifest(home, files) {
  const key = await readFile(join(home, 'keys', 'state-mac.key'));
  const mac = createHmac('sha256', key)
    .update('stroq-state-mac/1\nharden-manifest\n')
    .update(canonical({ version: 2, files }))
    .digest('hex');
  return `${JSON.stringify({ version: 2, files, mac }, null, 2)}\n`;
}
