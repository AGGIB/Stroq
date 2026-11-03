/** Fixed parent-process adapter. Workers use locked entry points and never acquire this lock. */
export { withConfigurationLock } from '../../packages/cli/src/config-lock.ts';
