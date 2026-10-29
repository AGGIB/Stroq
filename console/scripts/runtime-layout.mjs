import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The shipped layout is fixed by the build, never selected by environment or browser input. */
export function runtimeLayout(moduleUrl = import.meta.url) {
  const platform = resolve(dirname(fileURLToPath(moduleUrl)), '..');
  const packed = basename(platform) === 'platform';
  const repository = resolve(platform, '..');
  const cliRoot = packed ? repository : join(repository, 'packages/cli');
  return Object.freeze({
    repository,
    platform,
    cli: join(cliRoot, 'dist/index.js'),
    core: packed
      ? join(platform, 'core/index.js')
      : join(repository, 'packages/core/dist/index.js'),
    package: join(cliRoot, 'package.json'),
    manifest: join(
      platform,
      packed ? 'runtime-manifest.json' : '.local-engine/runtime-manifest.json',
    ),
    manifestRoot: repository,
    adapter(name) {
      if (!/^[a-z][\w.-]*\.(?:js|json)$/.test(name)) throw new Error('invalid-adapter');
      return join(platform, '.local-engine', name);
    },
  });
}
