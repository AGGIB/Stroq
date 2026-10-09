import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The repository root, where `tsx` can be found as a loader. */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * Calls `exportName` of a TypeScript module in a CHILD process and returns what it returned, as JSON.
 *
 * For code that reads a path someone else chose. A FIFO, or a link to one, makes a plain open wait for a
 * writer who is never going to come, and a test that waits with it is a test that never finishes. In a
 * child with a time limit, code that blocks is a failure with a name (the limit) instead of a hang.
 * The modules run this way import nothing from `@stroq/core`, which a loader outside vitest cannot find.
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
    ['--import', 'tsx', '--input-type=module', '-e', script],
    { cwd: ROOT, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(stdout) as unknown;
}
