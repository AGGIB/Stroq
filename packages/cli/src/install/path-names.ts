// What the readers of a tree and of a package.json agree a path to be, in one place.

/** A drive letter or a backslash start: a path on Windows, which Node reads as one. */
export const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\)/;

/** The folder the directory reader leaves out, in any case: `NODE_MODULES` is `node_modules` on a disk that folds case. */
export const isNodeModules = (name: string): boolean => name.toLowerCase() === 'node_modules';

/** Whether a component of the path (a tree path or one written in a package.json) is `node_modules`. */
export const inNodeModules = (path: string): boolean => path.split(/[\\/]/).some(isNodeModules);
