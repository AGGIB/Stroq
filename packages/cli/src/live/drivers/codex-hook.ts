import { lstatSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { windowsHookCommands } from '../../commands/hook-command.js';
import { shellWord } from '../probes.js';
import { assertThrowaway } from '../throwaway.js';
import type { ProbeContext } from '../types.js';

/** Keep the hook's home private without changing the host's authentication home. */
export function codexHookCommand(ctx: ProbeContext, hookLine: string): string {
  if (ctx.hookMode === 'noop') return 'node -e 0';
  assertThrowaway(ctx.home);
  const script = join(ctx.home, 'codex-stroq-hook.cjs');
  try {
    if (!lstatSync(script).isFile())
      throw new Error('the Codex hook wrapper is not a regular file');
    rmSync(script);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const source = [
    "const { spawnSync } = require('node:child_process');",
    "const { readFileSync } = require('node:fs');",
    `const env = {...process.env, HOME: ${JSON.stringify(ctx.home)}, USERPROFILE: ${JSON.stringify(ctx.home)}, STROQ_HOME: ${JSON.stringify(ctx.stroqHome)}};`,
    `const child = spawnSync(${JSON.stringify(hookLine)}, {shell: true, env, input: readFileSync(0), stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true});`,
    'process.exit(child.status ?? 2);',
  ].join('\n');
  writeFileSync(script, source, { flag: 'wx', mode: 0o600 });
  return process.platform === 'win32'
    ? windowsHookCommands(process.execPath, script, 'codex')[0]!
    : `${shellWord(process.execPath)} ${shellWord(script)}`;
}
