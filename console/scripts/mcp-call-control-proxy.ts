import { isAbsolute, resolve } from 'node:path';
import { parseMcpArgv, type McpInvocation } from '../../packages/cli/src/commands/mcp.ts';
import { wrapperIndex } from '../../packages/cli/src/commands/mcp-config.ts';
import type { ProxyRuntime } from './mcp-containment-proxy.ts';
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (): never => {
  throw new Error('mcp-call-control-unsupported');
};
const uuid = (v: string) => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const name = (v: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v) && v.length <= 256;
const unsafe = (v: string) =>
  /^(NODE_|STROQ_|LD_|DYLD_)/.test(v) ||
  ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'].includes(v);
function entryEnvironment(entry: Record<string, unknown>) {
  const env = Object.hasOwn(entry, 'env') ? entry.env : {};
  if (
    !object(env) ||
    Object.keys(env).length > 256 ||
    Object.entries(env).some(
      ([k, v]) => !name(k) || typeof v !== 'string' || v.length > 65536 || v.includes('\0'),
    )
  )
    return fail();
  return env as Record<string, string>;
}
export function callControlProxy(
  raw: unknown,
  server: string,
  client: string,
  runtime: ProxyRuntime,
  project: string,
  controlId: string,
): {
  entry: Record<string, unknown>;
  invocation: McpInvocation;
  configuration: 'plain' | 'wrapper' | 'controlled';
} {
  if (
    !uuid(controlId) ||
    !object(raw) ||
    typeof raw.command !== 'string' ||
    !raw.command ||
    raw.command.length > 4096 ||
    raw.command.includes('\0') ||
    Object.hasOwn(raw, 'url') ||
    Object.hasOwn(raw, 'serverUrl') ||
    (Object.hasOwn(raw, 'type') && raw.type !== 'stdio') ||
    (Object.hasOwn(raw, 'transport') && raw.transport !== 'stdio')
  )
    return fail();
  const args = Object.hasOwn(raw, 'args') ? raw.args : [];
  if (
    !Array.isArray(args) ||
    args.length > 256 ||
    args.some((v) => typeof v !== 'string' || v.length > 16384 || v.includes('\0'))
  )
    return fail();
  const env = entryEnvironment(raw),
    at = wrapperIndex(args);
  let next: string[], configuration: 'plain' | 'wrapper' | 'controlled';
  if (at !== null) {
    if (at !== 1 || raw.command !== runtime.command || args[0] !== runtime.entry) return fail();
    const parsed = parseMcpArgv(args.slice(2));
    if (
      !parsed.ok ||
      parsed.invocation.server !== server ||
      parsed.invocation.client !== client ||
      parsed.invocation.passEnv === null ||
      parsed.invocation.cwd === null ||
      !isAbsolute(parsed.invocation.cwd) ||
      env.STROQ_HOME !== runtime.home ||
      env.HOME !== runtime.userHome ||
      env.USERPROFILE !== runtime.userHome
    )
      return fail();
    if (
      parsed.invocation.passEnv.some((k) => !name(k) || unsafe(k) || !Object.hasOwn(env, k)) ||
      Object.keys(env).some((k) => unsafe(k) && !['STROQ_HOME', 'HOME', 'USERPROFILE'].includes(k))
    )
      return fail();
    const existing = parsed.invocation.callControlId;
    if (existing && existing !== controlId) return fail();
    configuration = existing ? 'controlled' : 'wrapper';
    next = existing
      ? [...args]
      : [
          ...args.slice(0, args.indexOf('--', 2)),
          '--call-control',
          controlId,
          ...args.slice(args.indexOf('--', 2)),
        ];
  } else {
    if (Object.keys(env).some(unsafe)) return fail();
    const cwd = Object.hasOwn(raw, 'cwd') ? raw.cwd : project;
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || resolve(cwd) !== cwd) return fail();
    next = [
      runtime.entry,
      'mcp',
      '--server',
      server,
      '--client',
      client,
      '--cwd',
      cwd,
      '--pass-env',
      Object.keys(env).sort().join(','),
      '--call-control',
      controlId,
      '--',
      raw.command,
      ...args,
    ];
    configuration = 'plain';
  }
  const parsed = parseMcpArgv(next.slice(2));
  if (!parsed.ok || parsed.invocation.callControlId !== controlId) return fail();
  return {
    entry: {
      ...raw,
      command: runtime.command,
      args: next,
      env: {
        ...env,
        STROQ_HOME: runtime.home,
        HOME: runtime.userHome,
        USERPROFILE: runtime.userHome,
      },
    },
    invocation: parsed.invocation,
    configuration,
  };
}
