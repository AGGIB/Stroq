import {
  backupsDirIn,
  bindingsFileIn,
  canaryFilesFileIn,
  cliDirIn,
  hardenDirIn,
  installRecordFileIn,
  keysDirIn,
  liveDirIn,
  openclawPluginDirIn,
  passportsFileIn,
  pluginCliDirIn,
  policyFileIn,
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
  keysDirIn,
  liveDirIn,
  hardenDirIn,
  backupsDirIn,
  storeDirIn,
  passportsFileIn,
  tasksDirIn,
  bindingsFileIn,
];

export const under = (home: string): string[] => PROTECTED.map((path) => path(home));
