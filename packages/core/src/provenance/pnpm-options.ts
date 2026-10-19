/**
 * The options of pnpm that take the word after them as a value, wherever they stand: before the
 * verb (`pnpm -C app add x`) and after `dlx` (`pnpm dlx --allow-build y x`, which `pnpx` is). The
 * command reader and the package reader each need them, and a name in one list and not the other
 * is a package read as the value of an option, or an option's value read as a package.
 */
export const PNPM_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-C',
  '--dir',
  '-F',
  '--filter',
  '--registry',
  '--reporter',
  '--store-dir',
  '--cache-dir',
  '--state-dir',
  '--lockfile-dir',
  '--modules-dir',
  '--virtual-store-dir',
  '--loglevel',
  '--node-options',
  '--workspace-concurrency',
  '--network-concurrency',
  '--use-node-version',
  '--allow-build',
]);
