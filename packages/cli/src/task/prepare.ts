import {
  copyFileSync,
  cpSync,
  mkdirSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const shellWord = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

export function prepareTask(home: string, taskId: string, entry: string) {
  const runs = join(home, 'task-runs');
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  if (
    lstatSync(runs).isSymbolicLink() ||
    relative(realpathSync(home), realpathSync(runs)) !== 'task-runs'
  )
    throw new Error('task runtime directory must be canonical and cannot be linked');
  const dir = mkdtempSync(join(runs, `${taskId}-`));
  let fakeHome: string | undefined;
  try {
    fakeHome = mkdtempSync(join(tmpdir(), `stroq-${taskId}-home-`));
    const config = join(fakeHome, '.claude');
    mkdirSync(config, { recursive: true, mode: 0o700 });
    mkdirSync(join(fakeHome, 'tmp'), { mode: 0o700 });
    const source = realpathSync(entry);
    if (!source.endsWith('.js')) throw new Error('task needs the built CLI; run pnpm build first');
    const cli = copyHookRuntime(source, dir);
    const command = `${shellWord(process.execPath)} ${shellWord(cli)} task-hook`;
    const hooks = Object.fromEntries(
      ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].map((event) => [
        event,
        [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 15 }] }],
      ]),
    );
    const settings = join(dir, 'settings.json');
    writeFileSync(settings, JSON.stringify({ hooks, disableAllHooks: false }), {
      mode: 0o600,
      flag: 'wx',
    });
    return { dir, fakeHome, settings, cli, sandbox: join(dir, 'sandbox.json') };
  } catch (err) {
    if (fakeHome !== undefined) rmSync(fakeHome, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function copyHookRuntime(source: string, dir: string): string {
  const cli = join(dir, 'dist', 'index.js');
  // tsup can split dynamic imports into sibling chunks. Copy the distribution, not just its entry.
  cpSync(dirname(source), dirname(cli), { recursive: true, dereference: true });
  copyFileSync(join(dirname(dirname(source)), 'package.json'), join(dir, 'package.json'));
  const require = createRequire(import.meta.url);
  for (const name of ['zod', 'yaml'])
    cpSync(dirname(require.resolve(`${name}/package.json`)), join(dir, 'node_modules', name), {
      recursive: true,
    });
  return cli;
}
