import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { windowsHookCommands } from '../../commands/hook-command.js';
import { shellWord } from '../probes.js';
import { assertThrowaway } from '../throwaway.js';
import type { ProbeContext } from '../types.js';

/** Keep the hook's home private without changing the host's authentication home. */
export function codexHookCommand(ctx: ProbeContext, hookLine: string): string {
  if (ctx.hookMode === 'noop') return 'node -e 0';
  assertThrowaway(ctx.home);
  // Never check then replace a path: an exclusive new file avoids a filesystem race.
  const script = join(ctx.home, `codex-stroq-hook-${randomUUID()}.cjs`);
  const source = [
    "const { spawnSync } = require('node:child_process');",
    "const { readFileSync } = require('node:fs');",
    'try {',
    `const env = {...process.env, HOME: ${JSON.stringify(ctx.home)}, USERPROFILE: ${JSON.stringify(ctx.home)}, STROQ_HOME: ${JSON.stringify(ctx.stroqHome)}};`,
    `const child = spawnSync(${JSON.stringify(hookLine)}, {shell: true, env, input: readFileSync(0), stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true});`,
    'process.exit(child.status ?? 2);',
    '} catch { process.exit(2); }',
  ].join('\n');
  writeFileSync(script, source, { flag: 'wx', mode: 0o600 });
  const command =
    process.platform === 'win32'
      ? windowsHookCommands(process.execPath, script, 'codex')[0]!
      : `${shellWord(process.execPath)} ${shellWord(script)}`;
  if (process.platform === 'win32' && /["']/.test(command))
    throw new Error(
      'Codex hook needs quote-free Windows paths; use a short temporary directory with 8.3 names enabled',
    );
  return command;
}
