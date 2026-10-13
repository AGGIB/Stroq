import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import type { PermitBody } from '@stroq/core';
import { canonicalTaskHome } from './validate.js';

/** srt's Linux write grants support literal paths and trailing /** only. Refuse silent skips. */
export function taskSandbox(
  body: PermitBody,
  input: {
    readonly home: string;
    readonly fakeHome: string;
    readonly cli: string;
    readonly node: string;
    readonly agent?: string;
    readonly broker: string;
    readonly platform: NodeJS.Platform;
    readonly canonical?: (path: string) => string;
  },
) {
  const write = body.scope.write.allow;
  if (
    input.platform !== 'darwin' &&
    write.some((path) => /[*?[\]]/.test(path.replace(/\/\*\*$/, '')))
  )
    throw new Error('this platform supports literal --write roots or a trailing /** only');
  const root = parse(body.projectRoot).root;
  const roots =
    input.platform === 'win32'
      ? [
          ...new Set([
            root,
            ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
              .split('')
              .map((drive) => `${drive}:/`)
              .filter(existsSync),
          ]),
        ]
      : ['/'];
  const canonical = input.canonical ?? canonicalTaskHome;
  const runtime = (
    input.platform === 'win32'
      ? [process.env['SystemRoot'] ?? 'C:/Windows', dirname(input.node)]
      : [
          '/usr',
          '/bin',
          '/lib',
          '/lib64',
          '/etc',
          ...(input.platform === 'darwin' ? ['/System', '/Library'] : []),
        ]
  ).map(canonical);
  const agentRuntime =
    input.agent === undefined
      ? []
      : [
          dirname(input.agent),
          ...[join(dirname(input.agent), 'node_modules', '@anthropic-ai', 'claude-code')].filter(
            existsSync,
          ),
        ];
  const safeAgentRuntime = agentRuntime.map(canonical);
  const normalized = canonical(input.home).replaceAll('\\', '/').toLowerCase();
  if (
    [...runtime, ...safeAgentRuntime].some(
      (path) =>
        normalized === path.replaceAll('\\', '/').toLowerCase() ||
        normalized.startsWith(`${path.replaceAll('\\', '/').toLowerCase()}/`),
    )
  )
    throw new Error('the Stroq home overlaps a runtime read allowance');
  return {
    filesystem: {
      denyRead: roots,
      allowRead: [
        ...runtime,
        ...safeAgentRuntime,
        input.node,
        dirname(dirname(input.cli)),
        input.fakeHome,
        ...body.scope.read.allow,
      ],
      allowWrite: [...write, input.fakeHome],
      denyWrite: [
        input.home,
        ...safeAgentRuntime,
        dirname(input.cli),
        join(dirname(dirname(input.cli)), 'node_modules'),
        join(dirname(dirname(input.cli)), 'package.json'),
        input.node,
        join(dirname(dirname(input.cli)), 'settings.json'),
        join(body.projectRoot, '.claude'),
        join(body.projectRoot, '.git'),
      ],
    },
    network: {
      allowedDomains: ['api.anthropic.com:443', new URL(input.broker).host],
      deniedDomains: [],
    },
  };
}
