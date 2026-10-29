import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { FileKeyStore, FilePermitStore, signPermit } from '@stroq/core';
import { loadPolicyWithSource } from '../engine-factory.js';
import { stroqHome } from '../paths.js';
import type { launch as realLaunch } from '../run/launch.js';
import { SRT_BIN } from '../run/sandbox.js';
import { binOnPath } from '../run/which.js';
import { parseTaskArgv } from '../task/args.js';
import { taskContract } from '../task/contract.js';
import { launchTask } from '../task/launch.js';
import { hasManagedTaskPolicy } from '../task/managed.js';
import { canonicalTaskHome, validateTaskExecutables, validateTaskPaths } from '../task/validate.js';
import { readClaudeVersion, requireClaudeVersion } from '../task/version.js';
import { confirm } from '../ui/prompt.js';
import { styleFor } from '../ui/style.js';
import { currentTerminal } from '../ui/terminal.js';

export interface TaskDeps {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly taskId?: () => string;
  readonly srt?: (env: NodeJS.ProcessEnv) => string | null;
  readonly launch?: typeof realLaunch;
  readonly confirm?: () => Promise<boolean>;
  readonly entry?: string;
  readonly claude?: string;
  readonly managed?: () => boolean;
  readonly version?: (agent: string, env: NodeJS.ProcessEnv) => string | null;
}

export async function confirmTask(): Promise<boolean> {
  const terminal = currentTerminal();
  return (
    terminal.interactive &&
    (await confirm(
      terminal,
      styleFor({ color: false, color256: false }),
      'Confirm this task permission?',
      false,
    ))
  );
}

export async function runTask(
  argv: readonly string[],
  cwd = process.cwd(),
  deps: TaskDeps = {},
): Promise<number> {
  const args = parseTaskArgv(argv);
  const env = deps.env ?? process.env;
  const srt = args.hookOnly ? null : (deps.srt ?? ((e) => binOnPath(SRT_BIN, e)))(env);
  if (!args.hookOnly && srt === null) {
    process.stderr.write(
      'stroq task: srt is required. Install @anthropic-ai/sandbox-runtime or explicitly choose advisory --hook-only. Nothing started.\n',
    );
    return 1;
  }
  const home = canonicalTaskHome(deps.home ?? stroqHome());
  if ((deps.managed ?? hasManagedTaskPolicy)()) {
    process.stderr.write(
      'stroq task: managed Claude settings can override the task hooks; this host is unsupported. Nothing started.\n',
    );
    return 1;
  }
  const agent = deps.claude ?? binOnPath('claude', env);
  if (agent === null) {
    process.stderr.write('stroq task: Claude Code is not on PATH. Nothing started.\n');
    return 1;
  }
  const agentPath = realpathSync(agent);
  // The same reading as the hook's: no file is the built-in default, a file it cannot read refuses.
  const { policy, source } = loadPolicyWithSource(join(home, 'policy.yaml'));
  const { body, screen } = taskContract(args, {
    cwd,
    taskId: (deps.taskId ?? randomUUID)(),
    now: (deps.now ?? (() => new Date()))(),
    policyDigest: source.sha256,
  });
  if (!args.hookOnly)
    validateTaskExecutables(body.projectRoot, process.execPath, agentPath, srt as string);
  validateTaskPaths(body, home, args.hookOnly);
  requireClaudeVersion((deps.version ?? readClaudeVersion)(agentPath, env));
  process.stdout.write(`${screen}\n`);
  if (!(await (deps.confirm ?? confirmTask)())) return 1;
  if (Date.parse(body.expiresAt) <= Date.now())
    throw new Error('task preview expired; start a fresh task');
  const keys = new FileKeyStore({ home }).loadOrCreate();
  const signed = signPermit(body, keys.privateKey);
  new FilePermitStore({ home }).writePermit(body.taskId, JSON.stringify(signed));
  return launchTask({
    signed,
    privateKey: keys.privateKey,
    home,
    policy,
    env,
    srt,
    agent: agentPath,
    task: args.task,
    deps,
  });
}
