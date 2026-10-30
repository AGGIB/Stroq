/**
 * The file `stroq` starts (`dist/index.js`; the CLI itself is `index.ts`).
 *
 * It exists for one reason: Node's compile cache covers only the modules loaded after it is turned
 * on, and the static imports of a module are all loaded before its first line runs. So the cache is
 * turned on here, and the CLI is loaded after it, by a dynamic import. See `compile-cache.ts`.
 *
 * Only for the hooks, which an agent starts on every tool call and which write the home anyway. A
 * command a person runs starts once, and the cache would be a folder it leaves behind.
 */
import { enableCompileCache } from './compile-cache.js';

const HOOKS: ReadonlySet<string> = new Set(['hook', 'task-hook']);

if (HOOKS.has(process.argv[2] ?? '')) enableCompileCache();
await import('./index.js');
