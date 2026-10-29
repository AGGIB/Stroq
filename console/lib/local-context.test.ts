import { it, expect } from 'vitest';
import { validateLocalContext } from './local-context';
it('accepts a named server-selected context without accepting browser-selected filesystem roots', () => {
  const value = {
    schema: 'stroq-context/1',
    workspace: { id: `workspace-${'a'.repeat(24)}`, label: 'repo' },
    userScope: 'Current OS user',
    homeMode: 'default',
  };
  expect(validateLocalContext(value)).toBe(true);
  expect(validateLocalContext({ ...value, path: '/private/profile' })).toBe(false);
  expect(
    validateLocalContext({
      ...value,
      workspace: { ...value.workspace, label: 'forged\nworkspace' },
    }),
  ).toBe(false);
});
