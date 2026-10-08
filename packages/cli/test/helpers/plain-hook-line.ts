import { vi } from 'vitest';

/**
 * For a test file that is not about Windows: `init` writes the usual quoted hook line, whatever machine the
 * file runs on. On a Windows runner the real `chooseHookCommand` would write the line without a quote for
 * Antigravity, Cursor and Codex, after starting it the way their hosts do, and the entry of a test run is
 * the test runner's worker, which starts nothing. The Windows cases are in `hook-command.test.ts` and
 * `init.test.ts`, which say what machine they mean.
 *
 *     vi.mock('../../src/commands/hook-command.js', async () =>
 *       (await import('../helpers/plain-hook-line.js')).plainHookLine());
 */
export async function plainHookLine(): Promise<
  typeof import('../../src/commands/hook-command.js')
> {
  const actual = await vi.importActual<typeof import('../../src/commands/hook-command.js')>(
    '../../src/commands/hook-command.js',
  );
  return {
    ...actual,
    chooseHookCommand: async (node, entry, agent) => ({
      command: actual.hookCommand(node, entry, agent),
      warning: null,
      refused: null,
    }),
  };
}
