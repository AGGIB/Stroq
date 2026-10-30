import { createRequire } from 'node:module';
import type * as Yaml from 'yaml';

let loaded: typeof Yaml | undefined;

/**
 * The `yaml` package, loaded the first time something reads YAML rather than with the module.
 *
 * The core reads YAML in two places: a policy file the user wrote (`load-policy.ts`) and rule files
 * at build time (`atr-loader.ts`). A hook call, a new process for every tool call an agent makes,
 * usually does neither, and loading the package costs it about 8 ms of 80 files. The package
 * resolves from this file as it would from a static import (`node` in its exports, CommonJS), so
 * it is the same code; it is only read later. If it could not be loaded, the error now surfaces
 * where the policy is read, inside the hook's own fail-closed handling.
 */
export function yaml(): typeof Yaml {
  loaded ??= createRequire(import.meta.url)('yaml') as typeof Yaml;
  return loaded;
}
