/** Fixed parent-process adapter. Workers use locked entry points and never acquire this lock. */
export { withManifestLock } from '../../packages/cli/src/harden/manifest.ts';
