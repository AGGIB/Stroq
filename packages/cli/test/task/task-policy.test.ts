import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTask } from '../../src/commands/task.js';

// A run that got past its policy would next ask the host for its version; answer it, so that only
// the policy can be what stops the run.
vi.mock('../../src/task/version.js', async (original) => ({
  ...(await original<typeof import('../../src/task/version.js')>()),
  readClaudeVersion: () => '2.1.271 (Claude Code)',
}));

const dirs: string[] = [];
afterEach(() => {
  dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  vi.restoreAllMocks();
});
const temp = () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'stroq-task-policy-')));
  dirs.push(dir);
  return dir;
};

/** The task reads its policy as the hook does: no default in place of a file it cannot read. */
describe('task policy source', () => {
  it.each([
    [
      'a link whose target is gone',
      (home: string) => symlinkSync(join(home, 'gone.yaml'), join(home, 'policy.yaml')),
    ],
    [
      'a file that is not a policy',
      (home: string) => writeFileSync(join(home, 'policy.yaml'), 'rules: [\n'),
    ],
  ])('refuses %s before asking, signing or launching', async (_, make) => {
    const home = temp();
    make(home);
    // Declining keeps even a wrongly admitted run from signing or launching anything.
    const confirm = vi.fn(async () => false);
    const launch = vi.fn();
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await expect(
      runTask(['--hook-only', '--', 'fix'], temp(), {
        home,
        claude: process.execPath,
        managed: () => false,
        confirm,
        launch,
      }),
    ).rejects.toThrow();
    expect(confirm).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'tasks'))).toBe(false);
  });
});
