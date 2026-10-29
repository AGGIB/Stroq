import {
  backupsDirIn,
  bindingsFileIn,
  canaryFilesFileIn,
  cliDirIn,
  compileCacheDirIn,
  hardenDirIn,
  installRecordFileIn,
  keysDirIn,
  liveDirIn,
  mcpCallControlsDirIn,
  openclawPluginDirIn,
  passportsFileIn,
  passportsLockDirIn,
  pluginCliDirIn,
  homeManifestFileIn,
  homeModulesDirIn,
  policyFileIn,
  runDirIn,
  secretsFileIn,
  storeDirIn,
  tasksDirIn,
  trustFileIn,
} from '../../src/paths.js';

/**
 * Every name under a Stroq home that the sandbox config protects, through `paths.ts`, in the order
 * the config writes them: a name renamed there cannot leave one unprotected here. The names that
 * no feature creates yet are on it on purpose, and so is the code the hooks run.
 */
export const PROTECTED: ReadonlyArray<(home: string) => string> = [
  policyFileIn,
  secretsFileIn,
  trustFileIn,
  canaryFilesFileIn,
  installRecordFileIn,
  cliDirIn,
  pluginCliDirIn,
  openclawPluginDirIn,
  compileCacheDirIn,
  keysDirIn,
  liveDirIn,
  hardenDirIn,
  backupsDirIn,
  storeDirIn,
  mcpCallControlsDirIn,
  runDirIn,
  homeModulesDirIn,
  homeManifestFileIn,
  passportsFileIn,
  passportsLockDirIn,
  tasksDirIn,
  bindingsFileIn,
];

export const under = (home: string): string[] => PROTECTED.map((path) => path(home));

/**
 * The one name listed off macOS whether or not it exists: the compile cache's folder, which a launch
 * makes before the config and which an agent that made it first could fill (`generateSandbox`).
 */
export const alwaysListed = (home: string): string => compileCacheDirIn(home);

/** The names whose listing off macOS depends on whether they exist, in the order of the list. */
export const ifThere = (home: string): string[] =>
  under(home).filter((path) => path !== alwaysListed(home));

/** What is listed off macOS when `there` exist: those, and the one listed regardless, in list order. */
export const listedOffMac = (home: string, there: readonly string[]): string[] =>
  under(home).filter((path) => path === alwaysListed(home) || there.includes(path));
