import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PermitBodySchema,
  canonicalBytes,
  isAbsoluteGlob,
  type PermitBody,
  type TaskScope,
} from '@stroq/core';
import type { TaskArgs } from './args.js';

export const sha256 = (text: string | Uint8Array): string =>
  createHash('sha256').update(text).digest('hex');

function globIn(root: string, glob: string): string {
  if (glob.split(/[\\/]/).includes('..')) throw new Error('task paths cannot contain ..');
  const absolute = resolve(root, glob).replaceAll('\\', '/');
  if (!isAbsoluteGlob(absolute)) throw new Error('invalid task path');
  const fold = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
  if (!fold(absolute).startsWith(`${fold(root)}/`))
    throw new Error('task paths must stay inside the project');
  return existsSync(absolute) && statSync(absolute).isDirectory() ? `${absolute}/**` : absolute;
}

export function taskContract(
  args: TaskArgs,
  input: {
    readonly cwd: string;
    readonly taskId: string;
    readonly now: Date;
    readonly policyDigest: string;
  },
): { readonly body: PermitBody; readonly screen: string } {
  const root = realpathSync(input.cwd).replaceAll('\\', '/');
  const paths = (values: readonly string[]) =>
    values.length === 0 ? [`${root}/**`] : values.map((value) => globIn(root, value));
  const scope: TaskScope = {
    tools: [
      'Read',
      'Glob',
      'Grep',
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
      'Bash',
      'TodoRead',
      'TodoWrite',
      'ExitPlanMode',
    ],
    read: { allow: paths(args.read), deny: [] },
    write: { allow: paths(args.write), deny: [] },
    net: { mode: 'none' },
    mcp: [],
    shell: 'allowed',
  };
  const screen = [
    `Task ${input.taskId}: ${args.task}`,
    `Profile: ${args.profile}`,
    `Project: ${root}`,
    `Read: ${scope.read.allow.join(', ')}`,
    `Write: ${scope.write.allow.join(', ')}`,
    `Tools: ${scope.tools.join(', ')}`,
    'Shell: allowed; tool network: none; MCP: none',
    'Sandbox runtime reads: system executables/libraries, the copied hook and the fake HOME.',
    `Expires: ${new Date(input.now.getTime() + args.ttlMs).toISOString()}`,
    args.hookOnly
      ? 'ADVISORY: --hook-only has no OS sandbox. Code can bypass hooks and read the signing key.'
      : 'OS sandbox: srt; fake HOME; API transport: api.anthropic.com',
  ].join('\n');
  const body = PermitBodySchema.parse({
    v: 1,
    taskId: input.taskId,
    nonce: randomBytes(24).toString('base64url'),
    host: 'claude-code',
    profile: args.profile,
    projectRoot: root,
    sessionId: randomUUID(),
    issuedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + args.ttlMs).toISOString(),
    policyDigest: input.policyDigest,
    stateDigests: {},
    scope,
    screenDigest: sha256(screen),
  });
  return { body, screen };
}

export const permitHash = (body: PermitBody): string => sha256(canonicalBytes(body));
