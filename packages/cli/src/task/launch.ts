import { randomBytes, type KeyObject } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  FilePermitStore,
  signTaskAccessRequest,
  type Policy,
  type SignedPermit,
} from '@stroq/core';
import type { TaskDeps } from '../commands/task.js';
import { hardeningEnv } from '../commands/inspect.js';
import { createEngineAt } from '../engine-factory.js';
import { launch as realLaunch } from '../run/launch.js';
import { srtArgv } from '../run/sandbox.js';
import { startTaskBroker } from './broker.js';
import { permitHash } from './contract.js';
import { taskEnvironment } from './environment.js';
import { taskGate } from './gate.js';
import { prepareTask } from './prepare.js';
import { writeReceipt } from './receipt.js';
import { taskSandbox } from './sandbox.js';

interface TaskLaunch {
  readonly signed: SignedPermit;
  /** Parent memory only: never included in child environment, runtime files or configuration. */
  readonly privateKey: KeyObject;
  readonly policy: Policy;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly srt: string | null;
  readonly agent: string;
  readonly task: string;
  readonly deps: TaskDeps;
}

export async function launchTask(input: TaskLaunch): Promise<number> {
  const { signed, home, policy, srt, agent, deps } = input;
  const { body } = signed;
  const pins: NodeJS.ProcessEnv = {
    STROQ_TASK_ID: body.taskId,
    STROQ_TASK_HASH: permitHash(body),
    STROQ_TASK_KEY_ID: signed.keyId,
    STROQ_TASK_NONCE: body.nonce,
    STROQ_TASK_ROOT: body.projectRoot,
  };
  let broker: Awaited<ReturnType<typeof startTaskBroker>> | undefined;
  let prepared: ReturnType<typeof prepareTask> | undefined;
  let exitCode: number | null = null;
  const stop = new AbortController();
  try {
    const engine = createEngineAt({
      home,
      userHome: homedir(),
      policy,
      scope: taskGate(home, policy, pins, (reason) => {
        process.stderr.write(`stroq task: ${reason}; stopping the agent.\n`);
        stop.abort();
      }),
      projectRoot: body.projectRoot,
      taskAccessSigner: (request) => signTaskAccessRequest(request, input.privateKey),
    });
    broker = await startTaskBroker(engine, randomBytes(24).toString('hex'), {
      cwd: body.projectRoot,
      sessionId: body.sessionId as string,
      onEventLimit: () => stop.abort(),
    });
    prepared = prepareTask(home, body.taskId, deps.entry ?? (process.argv[1] as string));
    configureSandbox(input, prepared, broker.url);
    const claudeArgs = taskArgv(input, prepared.settings);
    exitCode = await (deps.launch ?? realLaunch)({
      command: srt ?? agent,
      args: srt === null ? claudeArgs : srtArgv(prepared.sandbox, agent, claudeArgs),
      env: taskChildEnvironment(input, prepared.fakeHome, broker.url, pins),
      timeoutMs: Math.max(1, Date.parse(body.expiresAt) - Date.now()),
      stopSignal: stop.signal,
    });
    return exitCode;
  } finally {
    await broker?.close();
    new FilePermitStore({ home }).end(body.taskId);
    if (prepared !== undefined) {
      rmSync(prepared.fakeHome, { recursive: true, force: true });
      rmSync(prepared.dir, { recursive: true, force: true });
    }
    await writeReceipt(home, body.taskId, exitCode, body.mode ?? 'unknown');
    if (srt === null)
      process.stdout.write('ADVISORY: this run used --hook-only without OS isolation.\n');
    process.stdout.write(`Receipt: ${join(home, 'tasks', body.taskId, 'receipt.json')}\n`);
  }
}

function configureSandbox(
  input: TaskLaunch,
  prepared: ReturnType<typeof prepareTask>,
  broker: string,
): void {
  if (input.srt === null) return;
  const settings = taskSandbox(input.signed.body, {
    home: input.home,
    fakeHome: prepared.fakeHome,
    cli: prepared.cli,
    node: process.execPath,
    agent: input.agent,
    broker,
    platform: process.platform,
  });
  writeFileSync(prepared.sandbox, JSON.stringify(settings), { mode: 0o600, flag: 'wx' });
}

function taskChildEnvironment(
  input: TaskLaunch,
  fakeHome: string,
  broker: string,
  pins: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const clean = taskEnvironment(input.env);
  return {
    ...clean,
    ...hardeningEnv(clean),
    ...pins,
    STROQ_HOME: input.home,
    STROQ_TASK_BROKER: broker,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    CLAUDE_CONFIG_DIR: join(fakeHome, '.claude'),
    TMPDIR: join(fakeHome, 'tmp'),
    TEMP: join(fakeHome, 'tmp'),
    TMP: join(fakeHome, 'tmp'),
  };
}

function taskArgv(input: TaskLaunch, settings: string): readonly string[] {
  return [
    '--restricted',
    '--tools',
    input.signed.body.scope.tools.join(','),
    '--session-id',
    input.signed.body.sessionId as string,
    '--setting-sources',
    '',
    '--settings',
    settings,
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--',
    input.task,
  ];
}
