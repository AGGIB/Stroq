import { lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runtimeLayout } from './runtime-layout.mjs';

/** Share the existing harden lock with native-filter writers for these same files. */
export async function withAgentConfigurationLock(
  { home, version, runtime },
  action,
  { timeoutMs = 3000 } = {},
) {
  if (
    typeof home !== 'string' ||
    typeof action !== 'function' ||
    typeof version !== 'string' ||
    typeof runtime !== 'string' ||
    runtime.length > 200
  )
    throw new Error('agent-configuration-unavailable');
  try {
    const file = runtimeLayout().adapter('credential-filter-engine.js');
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024)
      throw new Error('agent-configuration-unavailable');
    const url = pathToFileURL(file);
    url.searchParams.set('runtime', runtime);
    const engine = await import(url.href);
    if (typeof engine.withManifestLock !== 'function')
      throw new Error('agent-configuration-unavailable');
    return await engine.withManifestLock({ home, version, now: () => new Date() }, action, {
      timeoutMs: Math.max(1, Math.min(3000, timeoutMs)),
    });
  } catch (error) {
    if (/^lock timeout:/.test(error?.message ?? '')) throw new Error('agent-configuration-busy');
    // Action errors carry fixed domain codes selected by the calling service.
    throw error;
  }
}
