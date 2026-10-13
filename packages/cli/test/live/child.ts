import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * `packages/cli`. A child started here finds its `tsconfig.json`, whose `paths` send `@stroq/core` to
 * the source of core, which is where the tests (through vitest's alias) find it too. Started anywhere
 * else it would load whatever build of core happens to be lying in `dist`, or none.
 */
export const CLI_PACKAGE = fileURLToPath(new URL('../..', import.meta.url));

/** The arguments that make `node` run TypeScript with those `paths`. */
export const TSX_ARGS: readonly string[] = ['--import', 'tsx'];

/**
 * Calls `exportName` of a TypeScript module in a CHILD process and returns what it returned, as JSON.
 *
 * For code that reads a path someone else chose. A FIFO, or a link to one, makes a plain open wait for a
 * writer who is never going to come, and a test that waits with it is a test that never finishes. In a
 * child with a time limit, code that blocks is a failure with a name (the limit) instead of a hang.
 */
export function inChild(
  modulePath: string,
  exportName: string,
  args: readonly unknown[],
  timeoutMs = 20_000,
): unknown {
  const script = [
    `const m = await import(${JSON.stringify(pathToFileURL(modulePath).href)});`,
    `const out = await m[${JSON.stringify(exportName)}](...${JSON.stringify(args)});`,
    'process.stdout.write(JSON.stringify(out ?? null));',
  ].join('\n');
  const stdout = execFileSync(
    process.execPath,
    [...TSX_ARGS, '--input-type=module', '-e', script],
    { cwd: CLI_PACKAGE, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(stdout) as unknown;
}
